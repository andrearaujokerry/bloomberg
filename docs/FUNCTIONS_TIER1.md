# FUNCTIONS_TIER1 — Tier 1: the functions a terminal is not credible without
Per-function manifests for the fourteen Tier 1 codes of [FUNCTIONS.md](./FUNCTIONS.md) §6 (`DES GP GIP HP Q QM W TOP N NI MSG WEI HELP SECF`), written to the template of FUNCTIONS.md §7 against ARCHITECTURE.md, API.md and DATA_MODEL.md.

## 0. Shared definitions for this file

Everything below is referenced by several entries and is defined once so the entries can be implemented independently (FUNC-01).

### 0.1 Files shared by Tier 1 manifests

| File | Content |
| --- | --- |
| `packages/core/src/functions/schemas.ts` | zod 4 enums used by every manifest and byte-identical to `sdk/wire/common.ts` (the SDK re-exports these from core): `AssetClass`, `MarketSector`, `Tier`, `ValueState`, `AdjustPolicy` (`'unadjusted'\|'price'\|'total_return'`), `Periodicity` (`'D'\|'W'\|'M'\|'Q'\|'Y'`), `FieldId` (regex `^[A-Z][A-Z0-9_]{1,39}$`), `SecurityRefInput` (`{id}\|{ref}\|{formula}`), `SortSpec = z.object({ col: z.string(), dir: z.enum(['asc','desc']) })` |
| `packages/core/src/functions/shared/news.ts` | `NewsRow` (§0.2) and `newsCsvColumns` (the TOP/N/NI export columns, §0.5) |
| `packages/core/src/functions/shared/monitor.ts` | `MonitorRow`, `MonitorColumn` (§0.2) and `monitorColumn(fieldId)` which derives `label`/`fmt`/`decimals` from `core/fields/dictionary.ts` |
| `packages/server/src/functions/shared/cells.ts` | `cellFromState(ctx, state: QuoteState \| undefined, field: FieldId, subject: string): ValueCell` (§0.4) and `pendingCell(subject, field)` |
| `packages/server/src/functions/shared/returns.ts` | `periodReturns(bars, calendar, asOfDate)` → `{ ret1d, ret1w, ret1m, retYtd, ret1y, high52w, low52w, avgVolume30d, vol30d }` using `core/analytics/stats` (§0.6 conventions) |
| `packages/server/src/functions/shared/instrumentSummary.ts` | `toSummary(detail: InstrumentDetail): InstrumentSummary` (API.md §3 shape) |
| `packages/web/src/screens/shared/quoteHeader.ts` | `quoteHeader(instrument, cells)` → the `kv#header` node every security screen shows first (key · name · `PX_LAST` · `CHG_NET_1D` · `CHG_PCT_1D` · session badge · state glyph) |
| `packages/web/src/screens/shared/newsList.ts` | `newsList(id, rows, opts)` → the `list` node used by TOP, N, NI, DES |

### 0.2 Shared payload types (`packages/core/src/functions/shared/*.ts`)

```ts
import type { FieldId } from '../../types/fields';
import type { ValueCell } from '../../types/function';
import type { AssetClass, MarketSector } from '../../types/instrument';

/** One headline as every news screen renders it. `machineGenerated` is always false in v1 (NEWS-08). */
export interface NewsRow {
  newsId: number; headline: string; summary: string | null;
  sourceId: 'bbg.rss' | 'sec.atom' | 'fed.rss'; feed: string;
  kind: 'story' | 'video' | 'filing' | 'press_release' | 'fed_release';
  author: string | null; category: string | null; cik: string | null; items8k: string[] | null;
  publishedAt: string; capturedAt: string; url: string; isCorrection: boolean; machineGenerated: false;
  links: Array<{ entityKind: 'instrument' | 'issuer' | 'person' | 'topic'; entityId: number; display: string; confidence: number;
                 method: 'cik' | 'ticker_exact' | 'name_exact' | 'name_alias' | 'feed_topic' | 'keyword' | 'manual' }>;
  provIdx: number;
}

/** One live row of a monitor grid (QM, W, WEI). `subject` is the plant subject the row's cells follow. */
export interface MonitorRow {
  instrumentId: number; key: string; name: string; assetClass: AssetClass; marketSector: MarketSector; exchCode: string;
  gicsSector: string | null; subject: string;                       // 'q:42'
  cells: Record<string, ValueCell>;                                  // keyed by column id (FieldId or 'c<n>' formula column)
}
export interface MonitorColumn { id: string; label: string; fieldId?: FieldId; fmt: 'px' | 'pct' | 'bp' | 'int' | 'ccy' | 'date' | 'datetime' | 'text' | 'shares'; decimals?: number; formula?: string }
```

### 0.3 Field ids introduced by Tier 1 (add to `core/fields/dictionary.ts` and `providers/licences.ts` per FUNCTIONS.md §1.8 step 6)

Every other id cited in this file is in the API.md §7 excerpt. These seven are new; `fieldClass` is `analytic`, `sources` is `{ assetClass:'*', sourceId:'internal.derived', endpoint:'bars_daily', providerPath:'core/analytics/stats' }`, `updateFreq:'daily'`, `pit:false`, `since:'2026.09.1'`.

| id | label | type / unit | decimals | derivation (`core/analytics/stats`, §0.6) | assetClasses |
| --- | --- | --- | --- | --- | --- |
| `PX_HIGH_52W` | 52-week high | number / price | null (instrument) | max `bars_daily.high` over the 252 sessions ending at the last completed session, adjusted by policy `price` | equity, etf, index, fx, crypto |
| `PX_LOW_52W` | 52-week low | number / price | null | min `bars_daily.low` over the same window | same |
| `VOLUME_AVG_30D` | 30-day average volume | integer / shares | 0 | mean `bars_daily.volume` over the last 30 sessions with volume > 0 | equity, etf, index, crypto |
| `RET_1W` | 1-week return | number / pct | 2 | `close(t) / close(t₋) − 1`, `t₋` = last session ≤ `t − 7 calendar days` | equity, etf, index, fx, crypto |
| `RET_1M` | 1-month return | number / pct | 2 | `t₋` = last session ≤ `t − 1 month` (same day-of-month, clamped) | same |
| `RET_1Y` | 1-year return | number / pct | 2 | `t₋` = last session ≤ `t − 1 year` | same |
| `DVD_YIELD` | Dividend yield (trailing 12 m) | number / pct | 2 | `DVD_SH_12M / PX_LAST × 100`; `DVD_SH_12M` = sum of `corporate_actions` cash dividends with `ex_date` in the trailing 365 days and status ∈ announced/confirmed/paid | equity, etf |

### 0.4 Cell rules used by every entry (TERM-12, ENTL-05, DATA-10)

1. **Plant-backed cells.** `cellFromState(ctx, state, field, subject)` returns `{ v: state.fields[field] ?? null, st: state.state, r: state.r?.[field], ts: state.fieldTs[field] ?? null, provIdx: ctx.prov.addQuote(state), live: { subject, field } }`. When `state` is `undefined` (instrument known, never polled) it returns `pendingCell(subject, field) = { v: null, st: 'blank', provIdx: -1, live: { subject, field } }` — no `r`, because nothing was denied: the screen renders `…` and the WS `snap` (or a `status 'pending'` frame) fills it. `provIdx: -1` is the documented "no provenance yet" value; `meta.provenance` is unaffected. A denied field arrives from `plant.snapshot` already nulled with `r` set; the cell keeps that `r`.
2. **Monitor resolvers never call `ctx.providers.ensure`.** QM, W and WEI read `plant.snapshotMany` and call `plant.ensureHot`; the scheduler polls cold subjects. This keeps goldens deterministic in `PROVIDER_MODE=replay` (a name without a recorded quote is simply pending) and keeps first paint under budget. Single-security screens (DES, Q, GIP) may `ensure` once when the subject is blank.
3. **Stored-value cells** (bars, facts, fixings) are `ValueCell` with `st:'closed'`, `ts` = source timestamp when known, `provIdx` from `ctx.prov.add(...)` and no `live`.
4. **Derived cells** (returns, market cap, yields from an engine) cite the `provIdx` of their primary input and, when an engine produced them, the engine is in `meta.engines`.
5. **Live subscription rule.** `LiveSpec.fields` is the union over all subjects; `packages/web/src/state/subscriptions.ts` intersects it with the subject family's field set (`q:`/`l:` → `QuoteFields` plus the asset class's extras; `b1m:` → bar fields; `oc:` → chain summary fields; `n:`/`e:`/`c:`/`room:` → `'*'`) before sending `sub`, so a `q:` subject is never asked for `BAR_TS` and an `n:` subject is always asked with `f: []` (API.md §6.1).
6. **Session-open note.** Screens that show completed sessions only (HP) add `footer.notes[]` = `['Session open — the current session appears after the close; see GIP']` when `plant.snapshot('q:<id>').session === 'open'`.

### 0.5 Shared CSV column sets

```ts
// packages/core/src/functions/shared/news.ts
export const newsCsvColumns: CsvColumn[] = [
  { id: 'publishedAt', label: 'Published', type: 'datetime' }, { id: 'sourceId', label: 'Source', type: 'string' }, { id: 'feed', label: 'Feed', type: 'string' },
  { id: 'kind', label: 'Kind', type: 'string' }, { id: 'headline', label: 'Headline', type: 'string' }, { id: 'url', label: 'URL', type: 'string' },
  { id: 'linkedKeys', label: 'Linked', type: 'string' } /* 'AAPL US Equity|SPX Index' */, { id: 'isCorrection', label: 'Correction', type: 'boolean' }, { id: 'newsId', label: 'News id', type: 'number' },
];
export const newsCsvRow = (r: NewsRow) => [r.publishedAt, r.sourceId, r.feed, r.kind, r.headline, r.url, r.links.map(l => l.display).join('|'), r.isCorrection, r.newsId];
```

### 0.6 Statistics conventions (ANAL-07) used by DES, WEI, HP summaries

`core/analytics/stats` exports `Conventions = { returns: 'simple', priceBasis: 'close', adjust: 'price', annualisation: 252, volWindow: 30, betaBenchmark: 'SPX Index', betaWindow: 252 }` and echoes it in every output; `periodReturns` uses the instrument's calendar (`instruments.primary_listing → exchanges.calendar_id`, `'FX_USD'` for fx, `'WEEKEND'` for crypto) to find `t₋`; `vol30d` = stdev of 30 daily simple returns × √252 × 100; `beta1y` = OLS slope of the instrument's 252 daily returns on `SPX Index` returns (only when both series cover ≥ 200 sessions, else `null` with `meta.unavailable` `NOT_APPLICABLE 'fewer than 200 overlapping sessions'`). Engine entry: `{ name: 'stats', version: '1.0.0', inputsHash }`.

### 0.7 Seed securities used by the goldens (`fixtures/golden/functions/<CODE>.<variant>.json`, frozen clock `2026-09-15T18:41:28Z`)

| Variant seed | Command-line form | Instrument id in seed | Recorded fixtures behind it (FIXTURES.md) |
| --- | --- | --- | --- |
| equity | `AAPL US Equity` | 42 | `cboe-quote-AAPL.json`, `yahoo-chart-events`, `yahoo-chart-AAPL-max-1d.json`, `yahoo-chart-AAPL-1d-1m.json`, `sec-submissions-AAPL.json`, `sec-companyfacts-AAPL.json`, `sec-nport-SPY-primary_doc.xml`, `finra-trace`, `cboe-options` |
| etf (→ `equity` variant, asserted inline, no separate golden) | `SPY US Equity` | seeded | `sec-spy-submissions.json`, `sec-nport-SPY-primary_doc.xml`, `ssga-spy-holdings.xlsx` |
| index | `SPX Index` | seeded | `cboe-spx`, `yahoo-chart-SPX-5d-5m.json`, N-PORT membership |
| fx | `EURUSD Curncy` | seeded | `yahoo-fx`, `frankfurter` |
| govt (bill) | `912797VE4 Govt` | seeded | `treasury-bills.xml` (4WK, maturity 2026-09-29) |
| govt (note, DES only, inline assertion) | `T 4.25 08/15/36 Govt` | seeded | `fixtures/seed/treasuries.json`, `treasury-xml2` |
| option | `AAPL 9/16/26 C245 Equity` (`AAPL260916C00245000`) | seeded | `cboe-options` |
| crypto | `BTC Crypto` | seeded | `coingecko-simple.json` |
| rate | `SOFR Index` | seeded | `nyfed-sofr`, `nyfed-all` |
| econ | `CUUR0000SA0 Index` (BLS CPI-U NSA; `DGS10 Index` for HP) | seeded | `bls-cpi.json`, `fred-DGS10.csv` |

Users: `pm@demo` (userId 2, firmId 1, delayed + export + api), `eod@demo` (eod-only grant), `compliance@demo`. Watchlists: `MAG7`, `S&P 500 Top 25`, `Core`. Rooms: 2 seeded (`Demo Capital` firm room, a dm), 6 messages.

---

### DES — Security Description

| Attribute | Value |
| --- | --- |
| Code / aliases | `DES` / `DESC` |
| Tier / category | 1 / reference |
| Asset classes → variants | `equity, etf → equity; index → index; fx → fx; govt → govt; option → option; crypto → crypto; rate → rate; econ → econ` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/DES.ts` · `packages/server/src/functions/DES/resolve.ts` (+ `equity.ts index.ts fx.ts govt.ts option.ts crypto.ts rate.ts econ.ts`) · `packages/web/src/screens/DES/Screen.tsx` (+ one component file per variant) · `fixtures/golden/functions/DES.{equity,index,fx,govt,option,crypto,rate,econ}.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (REF-01) (REF-02) (REF-03) (REF-04) (REF-05) (REF-07) (REF-08) (DATA-06) (DATA-10) (STOR-06) (TERM-03) (TERM-06) (TERM-11) (TERM-12) (ENTL-05) (ANAL-01) (ANAL-08) (NEWS-02) |

#### Params
```ts
export const DesParams = z.object({
  tab: z.enum(['profile', 'identifiers', 'listings', 'filings', 'news', 'members', 'terms', 'history']).default('profile'),
  filingsLimit: z.number().int().min(3).max(20).default(8),
  newsLimit: z.number().int().min(3).max(20).default(6),
});
```
#### Argument grammar
`positional [{ name:'tab', type:'enum', values:['profile','identifiers','listings','filings','news','members','terms','history'], optional:true }]`, `keyed { FILINGS: { name:'filingsLimit', type:'int' }, NEWS: { name:'newsLimit', type:'int' } }`, no `rest`.
Examples: `AAPL US Equity DES` → `{ tab:'profile', filingsLimit:8, newsLimit:6 }` · `DES FIL` → `{ tab:'filings', … }` (unique enum prefix) · `SPX Index DES MEMB NEWS=10` → `{ tab:'members', newsLimit:10, filingsLimit:8 }`.

The tab is a param so that every tab switch is one `fn.param` usage row (FUNC-04); a re-run is served from the plant and the request transaction in < 60 ms because the payload carries every block regardless of `tab` (the resolver ignores `tab`).

#### Payload
```ts
import type { InstrumentSummary } from '../../types/instrument';
import type { ValueCell, PayloadMeta } from '../../types/function';

export interface DesIssuerBlock {
  issuerId: number; name: string; legalName: string | null; cik: string | null; lei: string | null;
  sicCode: string | null; sicDescription: string | null; gicsSector: string | null; gicsIndustryGroup: string | null; gicsSubIndustry: string | null;
  countryOfIncorp: string | null; stateOfInc: string | null; fiscalYearEnd: string | null;   // 'MMDD'
  filerCategory: string | null; entityType: 'operating' | 'fund' | 'sovereign' | 'index_provider' | 'central_bank' | 'other';
  formerNames: Array<{ name: string; from: string; to: string | null }>; website: string | null; provIdx: number;
}
export interface DesQuoteBlock {                                  // every member is a plant cell with `live` (§0.4 rule 1)
  px: ValueCell; chgNet: ValueCell; chgPct: ValueCell; open: ValueCell; high: ValueCell; low: ValueCell; prevClose: ValueCell;
  volume: ValueCell; bid: ValueCell; ask: ValueCell; bidSize: ValueCell; askSize: ValueCell; lastTradeTime: ValueCell; ivol30d: ValueCell; sessionState: ValueCell;
}
export interface DesStatsBlock {                                  // bars/fundamentals derived, st:'closed' (§0.4 rules 3–4)
  high52w: ValueCell; low52w: ValueCell; avgVolume30d: ValueCell; vol30d: ValueCell; ret1d: ValueCell; ret1w: ValueCell; ret1m: ValueCell; retYtd: ValueCell; ret1y: ValueCell; beta1y: ValueCell;
  barsAsOf: string | null;                                       // last session date used
}
export interface DesEquityFundamentals {                          // point-in-time at meta.asOf.knownAt (STOR-06)
  sharesOut: ValueCell; sharesOutAsOf: string | null; publicFloat: ValueCell; mktCap: ValueCell;
  epsTtmDil: ValueCell; peTtm: ValueCell; revenueTtm: ValueCell; netIncomeTtm: ValueCell;
  dvdSh12m: ValueCell; dvdYield: ValueCell; lastDividend: { exDate: string; payDate: string | null; amount: number; currency: string; status: string; provIdx: number } | null;
  nextEarnings: { expectedDate: string; window: [string, string]; method: 'cadence' | 'prior_year'; estimated: true } | null;
  shortInterest: { settlementDate: string; shortQty: number; daysToCover: number | null; changePct: number | null; provIdx: number } | null;
  statementsAsOf: { periodEnd: string; filedAt: string; accessionNo: string } | null;
}
export interface DesFilingRow { accessionNo: string; form: string; filedDate: string; reportDate: string | null; acceptedAt: string | null; items: string[]; primaryDocDesc: string | null; url: string; isXbrl: boolean; provIdx: number }
export interface DesMembershipRow { indexCode: string; indexInstrumentId: number; indexKey: string; weight: number | null; shares: number | null; asOfDate: string; sourceId: string; provIdx: number }
export interface DesIdentifierRow { scheme: string; value: string; qualifier: string; isPrimary: boolean; validFrom: string }
export interface DesListingRow { listingId: number; figi: string | null; mic: string | null; exchCode: string; localTicker: string; isPrimary: boolean; listingStatus: string; mdLines: Array<{ mdLineId: number; sourceId: string; providerSymbol: string; lineKind: string; intrinsicDelayMin: number }> }

export type DesPayload =
  | { variant: 'equity'; instrument: InstrumentSummary; issuer: DesIssuerBlock;
      fund: { fundType: string; trackedIndex: { instrumentId: number; key: string } | null; sponsor: string | null; expenseRatio: number | null; inceptionDate: string | null;
              holdingsAsOf: string | null; holdingsCount: number | null; provIdx: number } | null;          // non-null for etf only
      quote: DesQuoteBlock; stats: DesStatsBlock; fundamentals: DesEquityFundamentals;
      membership: DesMembershipRow[]; filings: DesFilingRow[]; news: NewsRow[]; identifiers: DesIdentifierRow[]; listings: DesListingRow[];
      calendar: { calendarId: string; tz: string } }
  | { variant: 'index'; instrument: InstrumentSummary;
      terms: { provider: string; methodology: string; calcCurrency: string; region: string | null; baseDate: string | null; baseValue: number | null; constituentCount: number | null;
               proxyFund: { instrumentId: number; key: string } | null; membershipSourceId: string | null; provIdx: number };
      quote: Pick<DesQuoteBlock, 'px' | 'chgNet' | 'chgPct' | 'open' | 'high' | 'low' | 'prevClose' | 'ivol30d' | 'sessionState'>;
      stats: DesStatsBlock;
      membership: { asOfDate: string; count: number; sourceId: string; top10: Array<{ instrumentId: number; key: string; name: string; weight: number }>;
                    sectorWeights: Array<{ sector: string; weight: number; count: number }>; provIdx: number } | null;
      related: Array<{ key: string; label: string }>;                                                     // 'SPY US Equity' proxy, 'VIX Index'
      calendar: { calendarId: string; tz: string } }
  | { variant: 'fx'; instrument: InstrumentSummary;
      terms: { baseCcy: string; quoteCcy: string; spotLag: number; calendarId: string; pipSize: number; quoteConvention: 'quote_per_base' | 'base_per_quote'; provIdx: number };
      quote: Pick<DesQuoteBlock, 'px' | 'chgNet' | 'chgPct' | 'open' | 'high' | 'low' | 'prevClose' | 'sessionState'>;
      inverse: ValueCell;                                                                                 // 1 / px, derived, same provIdx as px
      stats: DesStatsBlock;
      ecb: { rateDate: string; baseCcyPerUsd: number | null; quoteCcyPerUsd: number | null; crossRate: number | null; provIdx: number } | null;   // frankfurter (ECB) reference
      calendar: { calendarId: string; tz: string } }
  | { variant: 'govt'; instrument: InstrumentSummary;
      terms: { cusip: string; securityType: 'bill' | 'note' | 'bond' | 'tips' | 'frn'; termLabel: string | null; issueDate: string | null; datedDate: string | null; maturityDate: string;
               couponType: string; couponRate: number | null; couponFreq: number; dayCount: string; firstCouponDate: string | null; businessDayConv: string; calendarId: string;
               settlementDays: number; minDenomination: number; amountOutstanding: number | null; onTheRun: boolean; issuer: string; provIdx: number };
      pricing: { settlementDate: string; daysToMaturity: number; yieldSource: 'bill_quote' | 'par_interp'; curveId: 'UST_BILL' | 'UST_PAR'; curveDate: string;
                 yield: ValueCell; discountRate: ValueCell; price: ValueCell; accrued: ValueCell; dirtyPrice: ValueCell;
                 macDuration: ValueCell; modDuration: ValueCell; convexity: ValueCell; dv01: ValueCell; provIdx: number } | null;   // null when matured
      identifiers: DesIdentifierRow[]; calendar: { calendarId: string; tz: string } }
  | { variant: 'option'; instrument: InstrumentSummary;
      terms: { occSymbol: string; root: string; underlying: { instrumentId: number; key: string; name: string }; expiry: string; strike: number; putCall: 'C' | 'P';
               exerciseStyle: string; settlement: string; amPm: string; multiplier: number; isWeekly: boolean; lastTradeDate: string | null; daysToExpiry: number; provIdx: number };
      quote: { bid: ValueCell; ask: ValueCell; last: ValueCell; lastTradeTime: ValueCell; volume: ValueCell; oi: ValueCell; prevClose: ValueCell; chgNet: ValueCell; chgPct: ValueCell;
               iv: ValueCell; delta: ValueCell; gamma: ValueCell; vega: ValueCell; theta: ValueCell; rho: ValueCell; theo: ValueCell };   // live on q:<contract>
      underlying: { px: ValueCell; chgPct: ValueCell };                                                   // live on q:<underlying>
      moneyness: { intrinsic: ValueCell; timeValue: ValueCell; pctFromSpot: ValueCell };                   // derived from quote + underlying
      chain: { expiries: string[]; contractCount: number | null; atmIv: ValueCell; putCallRatio: ValueCell } | null;   // oc:<underlying>
      calendar: { calendarId: string; tz: string } }
  | { variant: 'crypto'; instrument: InstrumentSummary; coingeckoId: string; px: ValueCell; chg24hPct: ValueCell; asOf: string | null;
      source: 'coingecko.simple'; caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA' }
  | { variant: 'rate'; instrument: InstrumentSummary;
      terms: { rateCode: string; publisher: string; dayCount: string; publicationTimeEt: string | null; tenorDays: number; compounding: string; seriesCode: string | null; provIdx: number };
      latest: { effectiveDate: string; rate: ValueCell; pct1: ValueCell; pct25: ValueCell; pct75: ValueCell; pct99: ValueCell; volumeBn: ValueCell; targetFrom: ValueCell; targetTo: ValueCell;
                revisionIndicator: string | null; vintageAt: string } | null;
      averages: { effectiveDate: string; avg30d: number | null; avg90d: number | null; avg180d: number | null; indexValue: number | null; provIdx: number } | null;   // SOFRAI row
      history: Array<{ effectiveDate: string; rate: number | null }>;                                     // last 30 fixings, is_latest, oldest first
      description: string }
  | { variant: 'econ'; instrument: InstrumentSummary;
      series: { seriesId: number; code: string; name: string; sourceId: string; providerCode: string; units: string; frequency: 'D' | 'W' | 'M' | 'Q' | 'A'; seasonalAdj: string | null;
                country: string; releaseName: string | null; decimals: number; firstObsDate: string | null; lastObsDate: string | null; provIdx: number };
      latest: { obsDate: string; value: ValueCell; status: string; vintageAt: string } | null;
      prior: { obsDate: string; value: number | null } | null;
      change: { abs: number | null; pct: number | null } | null;
      nextRelease: { scheduledAt: string; timeKnown: boolean; periodLabel: string; releaseId: number } | null;
      history: Array<{ obsDate: string; value: number | null; status: string }>;                            // last 24 observations as known at knownAt, oldest first
      knownAt: string };
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments`, `issues`, `issuers`, `listings`, `md_lines`, `identifiers`, `entity_classifications` + `classification_codes` (GICS, SIC), `index_terms`, `fund_terms`, `fx_terms`, `govt_terms`, `option_terms`, `rate_terms`, `index_members`, `etf_holdings`, `bars_daily`, `corporate_actions`, `xbrl_facts`, `fin_statements`, `short_interest`, `filings`, `news_items`, `news_entity_links`, `rate_fixings`, `econ_series`, `econ_observations`, `econ_release_events`, `econ_releases`, `curve_points`, `fx_rates`, `quote_snapshots` (through the plant), `option_quotes` (oc summary), `exchanges`, `calendars` — reference tables read as-of `ctx.asOf`; `xbrl_facts`/`fin_statements`/`econ_observations` read with `knownAt` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.members`, `data.historical.bars`, `data.fundamentals.statements`, `data.fundamentals.facts`, `data.filings.list`, `data.news.top('instrument')`, `data.rates.latest`, `data.rates.history`, `data.econ.series`, `data.econ.observations`, `data.econ.calendar`, `data.curves.points`, `data.options.chain`, `plant.subjectFor`, `plant.snapshot`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | equity: `('sec.submissions', cik, { maxAgeMs: 6*3600e3 })` before reading `filings`; `('sec.companyfacts', cik, { maxAgeMs: 24*3600e3 })` before reading fundamentals; `('cboe.quote', providerSymbol, { maxAgeMs: 30e3 })` only when the plant subject is blank. fx: `('yahoo.fx', 'EURUSD=X', { maxAgeMs: 60e3 })` when blank. crypto: `('coingecko.simple', coingeckoId, { maxAgeMs: 60e3 })` when blank. option: `('cboe.options', underlyingSymbol, { maxAgeMs: 60e3 })` when blank. rate: `('nyfed.rates', rateCode, { maxAgeMs: 3600e3 })`. econ: `('fred.series', providerCode, { maxAgeMs: 6*3600e3 })` for `fred.csv` series only. index, govt: none (curves and bars are scheduler-fed) |
| Engines (`core/analytics`) | `stats@1.0.0` (§0.6) for every variant with bars; govt: `bill@1.0.0` (bills) or `bond.price@1.0.0` + `bond.risk@1.0.0` (notes/bonds) |
| Subjects (live) | equity/index/fx/crypto: `q:<instrumentId>`; option: `q:<contractId>`, `q:<underlyingId>`, `oc:<underlyingId>`; rate: `q:<instrumentId>` (alias `r:<rateCode>`); econ: `e:<seriesCode>`; govt: none |
| Field ids (`fieldIds(assetClass)`) | `equity`/`etf`: `[PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, PX_VOLUME, PX_BID, PX_ASK, BID_SIZE, ASK_SIZE, LAST_TRADE_TIME, IVOL_30D, SESSION_STATE, NAME, TICKER, EXCH_CODE, ID_ISIN, ID_CUSIP, ID_BB_GLOBAL_COMPOSITE, ID_CIK, ID_LEI, CRNCY, SECURITY_TYP, SIC_CODE, GICS_SECTOR_NAME, COUNTRY_OF_INCORP, FISCAL_YEAR_END, FIRST_TRADE_DT, EQY_SH_OUT, PUBLIC_FLOAT, CUR_MKT_CAP, IS_EPS_DIL, PE_RATIO, SALES_REV_TURN, NET_INCOME, DVD_SH_12M, DVD_YIELD, EE_NEXT_REPORT_DT, SHORT_INT, SHORT_INT_RATIO, SHORT_INT_DT, IDX_MEMBER_WEIGHT, PX_HIGH_52W, PX_LOW_52W, VOLUME_AVG_30D, RET_1D, RET_1W, RET_1M, RET_YTD, RET_1Y, VOL_30D, BETA_1Y, HEADLINE]` · `index`: `[PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, IVOL_30D, SESSION_STATE, NAME, TICKER, CRNCY, IDX_MEMBER_WEIGHT, PX_HIGH_52W, PX_LOW_52W, RET_1D, RET_1W, RET_1M, RET_YTD, RET_1Y, VOL_30D]` · `fx`: `[PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, SESSION_STATE, NAME, TICKER, CRNCY, PX_HIGH_52W, PX_LOW_52W, RET_1D, RET_1W, RET_1M, RET_YTD, RET_1Y, VOL_30D]` · `govt`: `[NAME, TICKER, ID_CUSIP, SECURITY_TYP, CPN, CPN_FREQ, DAY_CNT_DES, MATURITY, ISSUE_DT, MTY_YEARS, YLD_YTM_MID, DISC_RATE, BEY, PX_DIRTY_MID, ACCRUED, DUR_MID, DUR_ADJ_MID, CONVEXITY_MID, DV01, CRV_1M]` · `option`: `[PX_BID, PX_ASK, PX_LAST, LAST_TRADE_TIME, PX_VOLUME, PX_CLOSE_1D, CHG_NET_1D, CHG_PCT_1D, OPT_STRIKE_PX, OPT_EXPIRE_DT, OPT_PUT_CALL, OPT_UNDL_TICKER, OPT_CONT_SIZE, OPT_OI, OPT_IV, OPT_DELTA, OPT_GAMMA, OPT_VEGA, OPT_THETA, OPT_RHO, OPT_THEO, OPT_UNDL_PX]` · `crypto`: `[PX_LAST, CHG_PCT_1D, LAST_TRADE_TIME, NAME, TICKER]` · `rate`: `[RATE, RATE_P1, RATE_P25, RATE_P75, RATE_P99, RATE_VOLUME_BN, TARGET_FROM, TARGET_TO, RATE_AVG_30D, RATE_AVG_90D, RATE_AVG_180D, RATE_INDEX, NAME, TICKER]` · `econ`: `[ECO_VALUE, ECO_PERIOD, ECO_VINTAGE, ECO_PRIOR, ECO_RELEASE_DT, NAME, TICKER]` |

#### Resolver
`resolve.ts` exports `{ resolve: equity, variants: { equity, etf: equity, index, fx, govt, option, crypto, rate, econ } }`. Common prologue (every variant): `detail = await ctx.data.reference.instrument(ctx.instrument.instrumentId)` (one query: instrument + issue + issuer + listings + md lines + identifiers + terms + classifications, as-of `ctx.asOf`); `instrument = toSummary(detail)`; `calendar` from the primary listing's exchange (`'FX_USD'` fx, `'WEEKEND'` crypto, `'SIFMA'` govt/rate, `'USGOVT'` econ). Every block cites a `provIdx` from `ctx.prov.add(detail.<row>.provenanceId …)`.

**equity** (also etf):
1. `subject = plant.subjectFor(id)`; `state = plant.snapshot(subject)`; if `state === undefined || state.state === 'blank'` and `usage !== 'export'`: `await providers.ensure('cboe.quote', cboeSymbol, { maxAgeMs: 30_000 })` once, then `snapshot` again. `quote.*` = `cellFromState` for `PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, PX_VOLUME, PX_BID, PX_ASK, BID_SIZE, ASK_SIZE, LAST_TRADE_TIME, IVOL_30D, SESSION_STATE`.
2. `bars = await data.historical.bars(id, { start: asOfDate − 400 calendar days, periodicity:'D', adjust:'price' })` (≤ 280 rows, one partition-pruned PK scan); `stats` = `periodReturns(bars, calendar, asOfDate)` → cells with `st:'closed'`, `ts` = last bar `source_ts`, `provIdx` = bars block; `ctx.engines.add(stats)`. Fewer than 2 bars → every stats cell `{ v:null, st:'na' }` and `unavailable.add({ field:'stats', reason:'NO_SOURCE', detail:'no daily bars for instrument' })`.
3. `cik = detail.issuer.cik`. If `cik`: `await providers.ensure('sec.submissions', cik, { maxAgeMs: 6h })`; `filings = (await data.filings.list(cik, { limit: params.filingsLimit })).items` mapped to `DesFilingRow` (url = `filings.url`). If no cik: `filings = []`, `unavailable.add({ field:'filings', reason:'NOT_APPLICABLE', detail:'issuer has no CIK' })`.
4. Fundamentals (STOR-06): `await providers.ensure('sec.companyfacts', cik, { maxAgeMs: 24h })`; `ttm = await data.fundamentals.statements(cik, { statement:'IS', periodType:'TTM', periods: 1, knownAt: ctx.asOf.knownAt })`; `facts = await data.fundamentals.facts(cik, ['dei:EntityCommonStockSharesOutstanding','dei:EntityPublicFloat'], 'instant', ctx.asOf.knownAt)` (latest `filed_at ≤ knownAt`). `sharesOut` = latest `EntityCommonStockSharesOutstanding` (`ts` = its `filed_at`), `mktCap.v = quote.px.v × sharesOut.v` (derived, `provIdx` of `px`, `live` omitted — it is recomputed client-side from the live `px` cell by the screen: `Cell.command`-free derived cell, see Screen), `epsTtmDil = ttm.eps_dil`, `peTtm = px / epsTtmDil` (null when `epsTtmDil ≤ 0` → `st:'na'`), `revenueTtm`, `netIncomeTtm`, `statementsAsOf = { periodEnd, filedAt, accessionNo }`. No `fin_statements` row → those cells `{ v:null, st:'na' }` + `unavailable.add({ field:'fundamentals', reason:'NO_SOURCE', detail:'no XBRL facts ingested for CIK <cik>' })`.
5. Dividends: `cas = corporate_actions` as-of, `ca_type ∈ (cash_dividend, special_dividend)`, `ex_date ≥ asOfDate − 365 d`, status ∈ announced/confirmed/paid → `dvdSh12m = Σ amount`, `dvdYield = dvdSh12m / px × 100`, `lastDividend` = greatest `ex_date`. None → `dvdSh12m.v = 0`, `dvdYield` derived, `lastDividend = null`.
6. `nextEarnings`: from `filings` forms `10-Q`/`10-K` (last 8) take the median gap between consecutive `filed_date` (`method:'cadence'`); `expectedDate = lastFiled + medianGap`, `window = [expectedDate − 7 d, expectedDate + 7 d]`; fewer than 3 such filings → `method:'prior_year'` = `filed_date` of the same form one year earlier + 365 d; none → `null` + `unavailable.add({ field:'nextEarnings', reason:'NO_SOURCE', detail:'no estimates source; no filing cadence available' })`.
7. `shortInterest` = latest `short_interest` row (`settlement_date ≤ asOfDate`) or `null`.
8. `membership` = current `index_members` rows for `instrument_id = id` joined to `indices` (`weight`, `as_of_date`, `source_id`) — one query on `index_members_inst_idx`.
9. `news = await data.news.top('instrument', id, params.newsLimit)` → `NewsRow[]` (link-out only, NEWS-02 links ≥ 0.9).
10. `fund` (etf only, `detail.terms.kind === 'fund'`): `fund_terms` + `etf_holdings` latest `as_of_date` count; `trackedIndex` from `tracked_index_instrument_id`.
11. `identifiers`, `listings` from `detail`; return `{ variant:'equity', … }`.
Budget: hot plant, warm SEC data: 7 DB round-trips (detail, bars, filings, statements, facts, corporate actions + short interest, membership + news) < 250 ms p95; first paint < 500 ms including a cold `cboe.quote` read-through (Tier 1 NFR).

**index**: prologue; `terms` from `index_terms`; `quote` cells (`PX_LAST` … `IVOL_30D` — `IVOL_30D` is Cboe-only, `st:'na'` for Yahoo-only indices); `stats` from bars (step 2 above); `membership`: when `indices.membership_source_id` is non-null → `members = await data.reference.members(id, asOfDate)`; `top10` by weight desc; `sectorWeights` by joining `entity_classifications` GICS sector of each member (one query); else `membership = null` + `unavailable.add({ field:'membership', reason:'NO_SOURCE', detail:'no membership source for <code> (only SPX has N-PORT/SSGA membership)' })`; `related` = `[proxy fund key, 'VIX Index' for SPX]`. 3 DB round-trips; < 200 ms p95.

**fx**: prologue; `terms` from `fx_terms`; `quote` cells from `q:<id>` (Yahoo line; `PX_BID/ASK` are not requested — not in the variant); `inverse = { v: 1 / px.v, … }` when `px.v`; `stats` from bars; `ecb`: latest `fx_rates` row set for `rate_date ≤ asOfDate`, `source_id='frankfurter'`, `base_ccy='USD'`: `baseCcyPerUsd = rates[base]` (`1` for USD), `quoteCcyPerUsd = rates[quote]`, `crossRate = quoteCcyPerUsd / baseCcyPerUsd` (EURUSD: `1 / 0.86663 = 1.15390`); missing currency → `ecb = null` + `unavailable.add({ field:'ecb', reason:'NO_SOURCE', detail:'currency not in ECB reference set' })`. 3 round-trips.

**govt** (ANAL-01, ANAL-08): prologue; `terms` from `govt_terms` as-of `ctx.asOf` (REF-03: a corrected coupon is visible only when `knownAt ≥ tx_from`). Conventions: settlement = `addBusinessDays(asOfDate_ET, terms.settlementDays, calendars.SIFMA)`; `daysToMaturity = maturityDate − settlementDate` (actual days). If `settlementDate ≥ maturityDate` → `pricing = null` + `unavailable.add({ field:'pricing', reason:'NOT_APPLICABLE', detail:'matured' })`.
- *bill*: `points = await data.curves.points('UST_BILL', latestDate ≤ asOfDate)`; pick the row with `instrument_id = id` (`yieldSource:'bill_quote'`); when absent, interpolate `investment_yield` linearly in `tenor_days` (`yieldSource:'par_interp'`, `curveId:'UST_BILL'`). `discountRate` = the `discount_rate` row (or linear interpolation); `price = billPriceFromDiscount(discountRate, daysToMaturity)` = `100 × (1 − d/100 × days/360)`; `yield = billBeyFromPrice(price, daysToMaturity)` (`days ≤ 182`: `(100 − P)/P × 365/days × 100`; `> 182`: the Treasury quadratic `BEY = (−2d/365 + 2√((d/365)² − (2d/365 − 1)(1 − 100/P))) / (2d/365 − 1) × 100`, `d = days`); `accrued.v = 0`, `dirtyPrice = price`; `macDuration = daysToMaturity/365`, `modDuration = macDuration / (1 + yield/100 × daysToMaturity/365)`; `convexity = macDuration²`; `dv01 = modDuration × price × 0.0001` (per 100 face); engine `bill@1.0.0` (day count ACT/360 for discount, ACT/365 for BEY).
- *note/bond/tips/frn*: `par = await data.curves.points('UST_PAR', latestDate)`; `yield` = linear interpolation of `par_yield` in `tenor_days` at `daysToMaturity` (`yieldSource:'par_interp'`); `price = priceFromYield({ settlement, maturity, couponRate, freq: terms.couponFreq, dayCount: terms.dayCount, yield })` from `core/analytics/bond/price.ts` — street convention: semiannual compounding, ACT/ACT-ICMA accrual per coupon period, regular schedule from `bond/cashflows.ts#couponSchedule` (bdc `terms.businessDayConv`, calendar `terms.calendarId`), odd first coupon when `firstCouponDate` is set; `accrued = accruedInterest(...)`; `dirtyPrice = price + accrued`; `macDuration`, `modDuration`, `convexity` from `bond/risk.ts` (modified = Macaulay / (1 + y/freq)); `dv01 = modDuration × dirtyPrice × 0.0001`. TIPS/FRN: priced as fixed on `couponRate` with `unavailable.add({ field:'pricing.inflation', reason:'NO_SOURCE', detail:'no index ratio / reference fixing source; priced as nominal' })`. Engines `bond.price@1.0.0`, `bond.risk@1.0.0`; every cell `st:'closed'`, `ts` = curve point `vintage_at`, `provIdx` = curve point provenance. 2 round-trips.

**option** (REF-05): prologue; `terms` from `option_terms` + underlying instrument; `daysToExpiry = expiry − asOfDate_ET`; `state = plant.snapshot('q:<contractId>')`, blank → `providers.ensure('cboe.options', underlyingCboeSymbol, { maxAgeMs: 60_000 })` once; `quote.*` cells for `PX_BID, PX_ASK, PX_LAST, LAST_TRADE_TIME, PX_VOLUME, OPT_OI, PX_CLOSE_1D, CHG_NET_1D, CHG_PCT_1D, OPT_IV, OPT_DELTA, OPT_GAMMA, OPT_VEGA, OPT_THETA, OPT_RHO, OPT_THEO`; `underlying.px/chgPct` from `q:<underlyingId>`; `moneyness`: `intrinsic = max(0, S − K)` (call) / `max(0, K − S)` (put) with `S = underlying.px.v`, `timeValue = mid − intrinsic` (`mid = (bid + ask)/2`), `pctFromSpot = (K/S − 1) × 100` — derived, `provIdx` of `underlying.px`; `chain` from `oc:<underlyingId>` (`EXPIRIES` split, `CONTRACT_COUNT`, `ATM_IV`, `PUT_CALL_RATIO`) or `null` when the summary subject is blank. 2 round-trips.

**crypto**: prologue; `coingeckoId = md_lines.provider_symbol` (`coingecko.simple`); `state = plant.snapshot(subject)`, blank → `ensure('coingecko.simple', id, 60 s)`; `px`, `chg24hPct` from `PX_LAST`, `CHG_PCT_1D`; `asOf = ISO(state.ts.src ?? state.ts.cap)`. 1 round-trip.

**rate**: prologue; `terms` from `rate_terms`; `latest = await data.rates.latest(rateCode)` (`rate_fixings` `is_latest`, greatest `effective_date`) → cells with `live: { subject:'q:<id>', field }` for `RATE, RATE_P1, RATE_P25, RATE_P75, RATE_P99, RATE_VOLUME_BN, TARGET_FROM, TARGET_TO` (`TARGET_*` are `st:'na'` for codes other than `EFFR`); `averages` = latest `SOFRAI` fixing when `rateCode === 'SOFR'`, else `null`; `history = await data.rates.history(rateCode, 30)`; `description` = fixed text per code from `packages/server/src/functions/DES/rateText.ts` (`'Secured Overnight Financing Rate — volume-weighted median of overnight Treasury repo; published 08:00 ET by the New York Fed; ACT/360'`). 2 round-trips.

**econ**: prologue; `series = await data.econ.series(code)` (`econ_series` + `econ_releases`); `obs = await data.econ.observations(code, { to: asOfDate, knownAt })` limited to the last 25 as known at `knownAt` (`vintage_at ≤ knownAt`, `DISTINCT ON (obs_date)`); `latest` = last, `prior` = previous, `change.abs = latest − prior`, `change.pct = abs / |prior| × 100` (null when prior is 0/null); `nextRelease` = first `econ_release_events` with `release_id = series.release_id AND scheduled_at > asOf` (null + `unavailable.add({ field:'nextRelease', reason:'NO_SOURCE', detail:'series has no release calendar entry' })`); `history` = the 24 before `latest`. 3 round-trips.

#### Live
```ts
live: (params, p) => {
  switch (p.variant) {
    case 'equity': return { subjects: [`q:${p.instrument.instrumentId}`], fields: ['PX_LAST','CHG_NET_1D','CHG_PCT_1D','PX_OPEN','PX_HIGH','PX_LOW','PX_CLOSE_1D','PX_VOLUME','PX_BID','PX_ASK','BID_SIZE','ASK_SIZE','LAST_TRADE_TIME','IVOL_30D','SESSION_STATE'], conflationMs: 250 };
    case 'index':  return { subjects: [`q:${p.instrument.instrumentId}`], fields: ['PX_LAST','CHG_NET_1D','CHG_PCT_1D','PX_OPEN','PX_HIGH','PX_LOW','PX_CLOSE_1D','IVOL_30D','SESSION_STATE'], conflationMs: 250 };
    case 'fx':     return { subjects: [`q:${p.instrument.instrumentId}`], fields: ['PX_LAST','CHG_NET_1D','CHG_PCT_1D','PX_OPEN','PX_HIGH','PX_LOW','PX_CLOSE_1D','SESSION_STATE'], conflationMs: 250 };
    case 'option': return { subjects: [`q:${p.instrument.instrumentId}`, `q:${p.terms.underlying.instrumentId}`, `oc:${p.terms.underlying.instrumentId}`],
                            fields: ['PX_BID','PX_ASK','PX_LAST','LAST_TRADE_TIME','PX_VOLUME','PX_CLOSE_1D','CHG_NET_1D','CHG_PCT_1D','OPT_OI','OPT_IV','OPT_DELTA','OPT_GAMMA','OPT_VEGA','OPT_THETA','OPT_RHO','OPT_THEO','EXPIRIES','ATM_IV','PUT_CALL_RATIO','CONTRACT_COUNT'],
                            conflationMs: 500, essential: [`q:${p.instrument.instrumentId}`, `q:${p.terms.underlying.instrumentId}`] };
    case 'crypto': return { subjects: [`q:${p.instrument.instrumentId}`], fields: ['PX_LAST','CHG_PCT_1D','LAST_TRADE_TIME'], conflationMs: 1000 };
    case 'rate':   return { subjects: [`q:${p.instrument.instrumentId}`], fields: ['RATE','RATE_P1','RATE_P25','RATE_P75','RATE_P99','RATE_VOLUME_BN','TARGET_FROM','TARGET_TO'], conflationMs: 5000 };
    case 'econ':   return { subjects: [`e:${p.series.code}`], fields: '*', conflationMs: 5000 };
    case 'govt':   return null;
  }
}
```
Cells carrying `live` are registered by the shell (`web/grid/cellRegistry`); `quote.*` are the only live cells in `equity`/`index`/`fx`; `mktCap` and `dvdYield` are re-derived by the screen on every `px` update (`Screen.tsx` computes `px.v × sharesOut.v` in the render from the `LiveView` value, so the kv shows a moving market cap without a resolver round-trip). `e:` deltas replace `latest.value.v` and prepend to `history`.

#### Screen
Title `DES · <display> · <name>`; subtitle = variant label (`Common Stock · XNAS · USD`, `S&P 500 Index · S&P Dow Jones`, `Spot FX · EUR/USD`, `US Treasury Bill · 4WK`, `Equity Option · AAPL`, `Overnight rate · NY Fed`, `Economic series · BLS`). `initialFocus: 'tabs'`. Skeleton while `payload === undefined`: `kv#header` with muted `—` values and the tab strip with the tab labels. Footer `sources` = `meta.provenance[].attribution` deduplicated in idx order; `asOf` = `meta.asOf.validAt`; for `equity`/`econ` the footer adds `knownAt=<meta.asOf.knownAt>` (PIT screens).

```
equity ───────────────────────────────────────────────────────────────────────────────────────────
┌ kv#header  AAPL US Equity · Apple Inc · 330.27 ▾ −2.81 (−0.84%) · [open] · ● live · Cboe delayed ┐
│ split row [0.5 | 0.5]                                                                            │
│  kv#profile (2 cols)                      │ kv#quote (2 cols, live cells)                        │
│   Issuer    Apple Inc  (legal name)       │  Last 330.27   Chg −2.81 / −0.84%   Bid/Ask 330.25 × 40 / 330.28 × 120 │
│   CIK 0000320193 · LEI —                  │  Open 330.24  High 331.59  Low 328.35  Prev 333.08  Vol 16,591,786    │
│   SIC 3571 Electronic Computers           │  IV30 24.43%  Last trade 14:26:26 ET                                   │
│   GICS Information Technology › Tech HW   │ kv#stats (2 cols)                                                       │
│   Inc. CA · FYE 09/26 · Large accel. filer│  52w H/L 344.57 / 236.32  AvgVol30d  RET 1D/1W/1M/YTD/1Y  Vol30d  β    │
│   Listing XNAS (UW) · first trade 1980-12-12 │ kv#fundamentals (2 cols)  ShOut · Float · MktCap · EPS TTM · P/E · Rev TTM · NI TTM · DPS 12m · Yield · Last div · Next earnings (est.) · Short int │
│ tabs#tabs [1 Profile][2 Identifiers][3 Listings][4 Filings][5 News][6 Members][7 Terms][8 History]                │
│   profile: text#description (issuer.formerNames, website)  · identifiers: table#identifiers (scheme,value,qualifier,primary,validFrom)
│   listings: table#listings · filings: list#filings (form · filed · items · Enter opens SEC) · news: list#news (newsList)
│   members: table#membership (index, weight, as-of, source) · terms: kv#fund (etf) or text 'Not applicable' · history: text 'Press H for HP'
└ footer  sources: Cboe delayed quotes … ; SEC EDGAR … ; Yahoo Finance chart v8 …   asOf …  knownAt … ───────────┘
index ────────  header | kv#terms (provider, methodology, ccy, base, count, proxy) | kv#quote + kv#stats | tabs [1 Profile][2 Members (top10 table + sectorWeights table)][3 Related]
fx ───────────  header (px 4 dp) | kv#terms (base/quote, spot lag, calendar, pip) | kv#quote + inverse | kv#stats | kv#ecb (ECB reference, date, cross)
govt ─────────  header (no live; yield in the header instead of px: 'BEY 3.75% · Disc 3.69% · Px 99.7015') | kv#terms (2 cols: CUSIP, type, maturity, coupon, freq, day count, dated, first coupon, bdc, calendar, settle T+1, min denom, outstanding, OTR) | kv#pricing (settlement, days, yield source/curve/date, yield, discount, price, accrued, dirty, Mac/Mod dur, convexity, DV01) | badges [engine bill/1.0.0 · curve UST_BILL 2026-09-12]
option ───────  header (contract key · underlying px live) | kv#terms | kv#quote (live: bid/ask/last/vol/OI, greeks as published by Cboe) | kv#moneyness | kv#chain (expiries badges, count, ATM IV, P/C)
crypto ───────  header | badges#caveat [CONTEXT_ONLY_NOT_EXCHANGE_DATA · CoinGecko] | kv#quote (px, 24h chg, as-of)
rate ─────────  header (RATE live) | kv#terms | kv#latest (rate, p1/p25/p75/p99, volume $bn, target range, revision, vintage) | kv#averages (SOFR only) | custom#Sparkline (history 30)
econ ─────────  header (latest value · period · Δ) | kv#series | kv#latest/prior/change/nextRelease | table#history (24 rows: period, value, status) · footer knownAt
```
`meta.entitlement` denials render `—` with the reason tooltip on the affected cells and one `badges#entitlement` row under the header (`PX_BID: TIER_EOD`); `meta.unavailable` entries render as a muted `badges#unavailable` row (`fundamentals: NO_SOURCE — no XBRL facts…`) and the affected kv rows show `—` with the detail as tooltip. `staleness` glyph `·` and colour follow `Cell.st` (TERM-12). Number keys `1`–`8` are the tab keys (rule §7.2.5); each switch calls `ctx.setParams({ tab })`.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1`…`8` | always | `tab-<n>` | `ctx.setParams({ tab: tabs[n-1] })` (equity has 8 tabs; other variants only their listed tabs) |
| `G` | always | `open-gp` | `ctx.navigate('GP')` |
| `Shift+G` | always | `open-gp-next` | `ctx.navigateNext('GP')` |
| `I` | always | `open-gip` | `ctx.navigate('GIP')` (not offered for govt/rate/econ: footer `GIP applies to Equity/Index/Curncy/Crypto`) |
| `H` | always | `open-hp` | `ctx.navigate('HP')` |
| `Q` | always | `open-q` | `ctx.navigate('Q')` (govt/econ: `NOT_APPLICABLE` footer) |
| `F` | always | `open-fa` | `ctx.navigate('FA')` (equity/etf only) |
| `C` | always | `open-cn` | `ctx.navigate('CN')` (equity/etf/index) |
| `A` | always | `open-cacs` | `ctx.navigate('CACS')` (equity/etf/index) |
| `M` | always | `open-memb` | `ctx.navigate('MEMB')` (index with membership; equity: `MEMB SPX` when a member) |
| `O` | always | `open-omon` | `ctx.navigate('OMON')` (equity/etf/index; option → `<underlying key> OMON`) |
| `V` | always | `open-ovml` | `ctx.navigate('OVML')` (option; equity/etf/index pick ATM) |
| `Y` | always | `open-yas` | `ctx.navigate('YAS')` (govt) |
| `E` | always | `open-eco` | `ctx.navigate('ECO')` (econ) / `FED` (rate) |
| `Enter` | grid (`list#filings`) | `open-filing` | `ctx.openUrl(row.url)` (SEC EDGAR index page) |
| `Enter` | grid (`list#news`) | `open-news` | `ctx.openUrl(item.url)` (link-out only; bodies are never stored) |
| `Enter` | grid (`table#membership`) | `open-index` | `ctx.navigate(row.indexKey + ' MEMB')` |
| `Enter` | grid (`table#identifiers`) | `copy-identifier` | copies `value` to the clipboard, footer `copied` |
| `Ctrl+W` | always | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems(id, [...items, { security: { id } }])` |
| `Ctrl+I` | always | reserved | provenance panel of the focused cell (shell) |

#### CSV
`filename = 'DES_' + display.replace(/[^A-Za-z0-9]+/g, '_') + '_' + asOf.replace(/[-:]/g, '') + '.csv'` (`DES_AAPL_US_Equity_20260915T184128Z.csv`). Long format (§1.6 rule 3), static columns `section,key,value,unit,asOf,source`:
- `section` ∈ `instrument, issuer, quote, stats, fundamentals, membership, filings, news, identifiers, listings, terms, pricing, latest, averages, history, series, ecb, chain, moneyness` (per variant, in payload order); `key` = the payload property (`px`, `chgPct`, `filings[3].form`…); `value` = `ValueCell.v` or the primitive (`null` → empty); `unit` = dictionary unit (`price`, `pct`, `shares`, `ccy`, `date`, `text`); `asOf` = `ValueCell.ts` ISO or the block's date; `source` = `meta.provenance[provIdx].sourceId` (`internal.derived` for derived cells).
- Array blocks emit one row per element and property: `filings,filings[0].form,8-K/A,text,2026-09-01,sec.submissions`.
Example row: `quote,px,330.27,price,2026-09-15T18:26:26Z,cboe.quotes`.

#### Help
summary `Security description: profile, identifiers, live quote, terms, membership, filings, news`; description `DES is the landing screen for any security. It shows who issued it, how it is identified (FIGI, ISIN, CUSIP, CIK, LEI), the live composite quote with its source and staleness, one-year statistics, point-in-time fundamentals from SEC XBRL (as known at the knownAt shown in the footer), index membership, the latest filings and headlines. The screen differs by asset class: equities and ETFs show issuer and fundamentals, indices show methodology and top constituents, FX shows conventions and the ECB reference rate, Treasuries show full terms and curve-implied pricing (settlement T+1, ACT/360 discount for bills, street convention for notes), options show contract terms with Cboe-published greeks, rates show the latest fixing with percentiles, economic series show the latest observation and the next release. Numbers marked with a dash are unavailable for the reason shown; nothing is estimated.`; params `tab` ("Which lower block is open", example `FILINGS`), `filingsLimit` ("Filings shown, 3–20", example `FILINGS=12`), `newsLimit` ("Headlines shown, 3–20", example `NEWS=10`); sources `['cboe.quotes','yahoo.chart','openfigi.mapping','sec.tickers','sec.submissions','sec.companyfacts','sec.archives','ssga.holdings','wiki.sp500','finra.shortInterest','bbg.rss','sec.atom','treasury.yieldcurve','treasury.bills','nyfed.rates','fred.csv','bls.timeseries','frankfurter','coingecko.simple','cboe.options','internal.derived']`; related `['GP','GIP','HP','Q','FA','CN','CACS','MEMB','OMON','YAS','ECO']`.

#### Unavailable and reason codes
| `field` | `reason` | `detail` | When |
| --- | --- | --- | --- |
| `stats` | `NO_SOURCE` | `no daily bars for instrument` | fewer than 2 `bars_daily` rows |
| `stats.beta1y` | `NOT_APPLICABLE` | `fewer than 200 overlapping sessions` | §0.6 |
| `filings` | `NOT_APPLICABLE` | `issuer has no CIK` | non-SEC issuer |
| `fundamentals` | `NO_SOURCE` | `no XBRL facts ingested for CIK <cik>` | no `fin_statements`/`xbrl_facts` |
| `nextEarnings` | `NO_SOURCE` | `no estimates source; no filing cadence available` | < 1 periodic filing (BRIEF §2: no consensus source; the date is projected from filing cadence, never an estimate) |
| `membership` | `NO_SOURCE` | `no membership source for <code> (only SPX has N-PORT/SSGA membership)` | index without `membership_source_id` |
| `ecb` | `NO_SOURCE` | `currency not in ECB reference set` | frankfurter lacks base or quote |
| `pricing` | `NOT_APPLICABLE` | `matured` | govt settlement ≥ maturity |
| `pricing.inflation` | `NO_SOURCE` | `no index ratio / reference fixing source; priced as nominal` | TIPS / FRN |
| `chain` | `NO_SOURCE` | `no chain summary for underlying` | `oc:` blank and `ensure` failed |
| `nextRelease` | `NO_SOURCE` | `series has no release calendar entry` | econ |
Footer/badge codes: `CONTEXT_ONLY_NOT_EXCHANGE_DATA` (crypto); entitlement reasons per `meta.entitlement` (`TIER_EOD` for `eod@demo` on `PX_BID/PX_ASK/PX_LAST`; `NO_FIRM_ENTITLEMENT`); `PROVIDER_DOWN` → cells `stale` with last values and the header glyph `·`.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules (shared) |
| golden payload | `packages/server/test/integration/functions/DES.golden.test.ts` | each of the eight variants at the frozen clock deep-equals `DES.<variant>.json`; `SPY US Equity` yields `variant:'equity'` with `fund !== null` and `fund.trackedIndex.key === 'SPX Index'`; `T 4.25 08/15/36 Govt` yields `pricing.yieldSource === 'par_interp'` and engines `bond.price`, `bond.risk` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `DES.<variant>.csv`; every numeric cell equals its payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot for `quote.*` cells (API-05) |
| screen | `packages/web/test/screens/DES.test.tsx` | renders each golden variant; every keymap action reachable by keyboard; `quote.*` cells registered as live; `1`–`8` call `setParams`; skeleton on `payload undefined`; `meta.unavailable` badges rendered |
| point-in-time | `packages/server/test/integration/functions/DES.pit.test.ts` | with `asOf.knownAt = 2026-06-01` the AAPL `statementsAsOf.filedAt ≤ 2026-06-01` and `revenueTtm` differs from the current value (STOR-06); with the seeded coupon correction of `bitemporal.test.ts`, `terms.couponRate` is 4.5 at `knownAt 2026-03-05` and 4.25 at `2026-03-12` (REF-03) |
| bill pricing | `packages/core/test/analytics/bill.test.ts` + `fixtures/golden/analytics/bill/912797VE4.json` | `price(3.69, 14 d) = 99.8565`, `BEY = 3.75 ± 0.01` vs the Treasury-published yield |
| entitlement | `packages/server/test/integration/functions/DES.entitlement.test.ts` | `eod@demo` gets `quote.px.v === null`, `r:'TIER_EOD'`, `meta.entitlement` lists the downgrades, `PX_OFFICIAL_CLOSE` path still populates `prevClose` (ENTL-05) |
| provider down | `packages/server/test/integration/functions/DES.stale.test.ts` | circuit open + stored snapshot → `quote.px.st === 'stale'`, `meta.staleness === 'stale'`, no throw; circuit open + nothing stored → `503 PROVIDER_UNAVAILABLE` |
| e2e | `packages/e2e/tests/command-line.spec.ts` | `AAPL US Equity DES <GO>` paints the header with `330.27` within 500 ms; `4` opens the filings tab; `Enter` on a filing opens an `sec.gov` URL in a new tab; `SPX Index` (security-only) reloads DES in the index variant (TERM-03) |

---

### GP — Price Graph

| Attribute | Value |
| --- | --- |
| Code / aliases | `GP` / `GRAPH`, `CHART` |
| Tier / category | 1 / charting |
| Asset classes → variants | `equity, etf → equity; index → index; fx → fx; govt → govt; option → option; crypto → crypto; rate, econ → series` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `custom` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/GP.ts` · `packages/server/src/functions/GP/resolve.ts` (+ `series.ts`, `events.ts`) · `packages/web/src/screens/GP/Screen.tsx` (+ `spec.ts` building the `ChartSpec`) · `fixtures/golden/functions/GP.{equity,index,fx,govt,option,crypto,series}.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (CHRT-01) (CHRT-02) (CHRT-03) (CHRT-04) (CHRT-05) (CHRT-06) (CHRT-07) (REF-06) (REF-09) (STOR-06) (TERM-06) (TERM-12) (DATA-10) (ENTL-05) |

#### Params
```ts
export const GpParams = z.object({
  range: z.enum(['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'MAX', 'CUSTOM']).default('1Y'),
  start: z.iso.date().optional(), end: z.iso.date().optional(),                    // used when range === 'CUSTOM'
  periodicity: z.enum(['auto', '1m', '5m', 'D', 'W', 'M']).default('auto'),          // auto: 1D→1m, 5D→5m, ≤2Y→D, ≤10Y→W, MAX→M
  type: z.enum(['line', 'area', 'mountain', 'candle', 'ohlc', 'bar', 'step', 'pnf', 'profile', 'heatmap', 'tick']).default('line'),
  adjust: AdjustPolicy.default('price'),
  overlays: z.array(SecurityRefInput).max(5).default([]),
  normalise: z.enum(['none', 'pct', 'base100']).default('none'),                    // forced to 'pct' when overlays.length > 0 and normalise === 'none'
  currency: z.string().length(3).optional(),
  studies: z.array(z.object({ id: z.string().max(24), params: z.record(z.string(), z.number()).default({}), pane: z.enum(['main', 'sub']).default('sub') })).max(8).default([]),
  events: z.object({ earnings: z.boolean().default(true), dividends: z.boolean().default(true), splits: z.boolean().default(true), news: z.boolean().default(false),
                     filings: z.boolean().default(false), indexChanges: z.boolean().default(true), fomc: z.boolean().default(true) }).default({}),
  logScale: z.boolean().default(false),
  volume: z.boolean().default(true),
});
```
#### Argument grammar
`positional [{ name:'range', type:'range', optional:true }, { name:'start', type:'date', optional:true }, { name:'end', type:'date', optional:true }]`, `keyed { TYPE: { name:'type', type:'enum', values:[…GpParams.type] }, ADJ: { name:'adjust', type:'enum', values:['unadjusted','price','total_return'] }, VS: { name:'overlays', type:'security' } /* repeatable: each VS= appends */, CCY: { name:'currency', type:'currency' }, NORM: { name:'normalise', type:'enum', values:['none','pct','base100'] }, PER: { name:'periodicity', type:'enum', values:['auto','1m','5m','D','W','M'] }, LOG: { name:'logScale', type:'boolean' } }`, no `rest`. Enum short aliases declared in the manifest: `ADJ=TR → total_return`, `ADJ=PX → price`, `ADJ=UN → unadjusted`.
Examples: `GP` → `{ range:'1Y', periodicity:'auto', type:'line', adjust:'price', … }` · `GP 5Y TYPE=CANDLE ADJ=TR` → `{ range:'5Y', type:'candle', adjust:'total_return' }` · `GP 2020-01-01 2020-12-31 VS=MSFT US Equity NORM=BASE100` → `{ range:'CUSTOM', start:'2020-01-01', end:'2020-12-31', overlays:[{ ref:'MSFT US Equity' }], normalise:'base100' }` (a date in the first positional slot sets `range:'CUSTOM'`).

#### Payload
```ts
export interface GpSeries {
  ref: SecurityRefInput; instrument: InstrumentSummary | null;          // null for a formula series (CHRT-07)
  formula: string | null; key: string; label: string; currency: string; calendarId: string; tz: string;
  unit: 'price' | 'yield' | 'index' | 'pct' | 'rate';                    // y-axis format hint
  t: number[];                                                            // epoch ms, bar start (UTC); ascending
  o: number[] | null; h: number[] | null; l: number[] | null; c: number[]; v: number[] | null;   // NaN = gap; o/h/l/v null when the source has no OHLC/volume
  adjust: AdjustPolicy; periodicity: '1m' | '5m' | 'D' | 'W' | 'M';
  sessions: Array<{ start: number; end: number; kind: 'pre' | 'regular' | 'post' }> | null;        // intraday only
  converted: { from: string; to: string } | null;                        // currency conversion applied (fx_rates at each session date)
  provIdx: number;
  live: { subject: string; field: FieldId; mode: 'append-forming-bar' | 'replace-last' } | null;
}
export interface GpEvent { t: number; kind: 'earnings' | 'dividend' | 'split' | 'news' | 'filing' | 'index_add' | 'index_drop' | 'fomc'; label: string; command: string; provIdx: number }
export interface GpAnnotation { annotationId: number; kind: 'trendline' | 'hline' | 'vline' | 'fib' | 'text' | 'regression_channel' | 'rect'; anchors: Array<{ t: number; v: number }>; label: string | null; style: Record<string, unknown>; ownerUserId: number; sharedScope: 'private' | 'firm' | 'users'; editable: boolean }
export type GpPayload = {
  variant: 'equity' | 'index' | 'fx' | 'govt' | 'option' | 'crypto' | 'series';
  primary: GpSeries; overlays: GpSeries[];
  events: GpEvent[]; annotations: GpAnnotation[];
  window: { start: string; end: string; range: GpParams['range']; periodicity: GpSeries['periodicity']; bars: number };
  last: ValueCell;                                                        // PX_LAST of the primary (live) — the crosshair default
  reference: Array<{ label: 'prev close' | 'par' | 'strike'; v: number }>;
  adjustments: NonNullable<PayloadMeta['adjustments']>;                   // also in meta; repeated so the screen can badge them
  fx: Array<{ base: string; quote: string; points: Array<[number, number]>; provIdx: number }>;   // rates used when converted
};
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `bars_daily` (unadjusted, `md_line_id` of the primary line), `bars_intraday` (`1m`/`5m`), `corporate_actions` (as-of `ctx.asOf`, REF-09), `filings` (10-Q/10-K, 8-K item 2.02 → earnings; 8-K → filing markers), `news_items` + `news_entity_links`, `index_members` (version boundaries → add/drop), `fomc_meetings`, `fx_rates`, `chart_annotations` (RLS: own + shared), `curve_points` (govt: `UST_PAR`/`UST_BILL` tenor history), `option_quotes` (option), `quote_ticks` (crypto), `rate_fixings`, `econ_observations` (PIT), `calendars`, `exchanges` |
| Data services | `data.historical.bars`, `data.intraday.bars`, `data.reference.resolve` (overlays), `data.reference.instrument`, `data.filings.list`, `data.news.search`, `data.econ.observations`, `data.rates.history`, `data.curves.points`, `data.ticks.last`, `plant.snapshot`, `plant.subjectFor`, `sdk`-side `workspace.annotations.list` is not used — annotations come through `ctx.db` (`chart_annotations` under RLS) in the resolver |
| Read-through | `('yahoo.daily', providerSymbol, { maxAgeMs: 6*3600e3 })` when the requested window ends after the last stored `session_date` by more than one session; `('yahoo.intraday', providerSymbol, { maxAgeMs: 60e3 })` for `1m`/`5m`; `('yahoo.fx', 'EURUSD=X', …)` for fx intraday; none for govt/rate/econ (scheduler-fed) |
| Engines | `adjust@1.0.0` (`core/adjust/corporateActions.ts`, `price`/`total_return`), `formula@1.0.0` (`core/formula` evaluator for formula refs), `resample@1.0.0` (W/M roll-ups: last session of ISO week / calendar month; open = first, high = max, low = min, close = last, volume = sum) |
| Subjects (live) | primary and each overlay instrument: `q:<id>` (D/W/M) or `b1m:<id>` (1m/5m); formula series and govt/rate/econ: none |
| Field ids | `equity`/`index`/`fx`/`crypto`/`option`: `[PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME, PX_CLOSE_1D, LAST_TRADE_TIME, BAR_TS, IS_FINAL, TOT_RETURN_INDEX, HEADLINE]` · `govt`: `[CRV_1M, YLD_YTM_MID, BEY]` · `series` (rate): `[RATE]`; (econ): `[ECO_VALUE, ECO_VINTAGE]` |

#### Resolver
1. **Window.** `end = params.end ?? asOfDate`; `start` by range: `1D` = last session date (intraday), `5D` = 5 sessions, `1M`…`10Y` = calendar arithmetic on `end`, `YTD` = Jan 1, `MAX` = `instruments.first_trade_date ?? 1970-01-01`, `CUSTOM` = `params.start` (400 `VALIDATION_FAILED` `fnParams` when missing). `periodicity` `auto` per the table in Params. Intraday (`1m`/`5m`) is limited to `5D` (`ARG_PARSE`-style clamp: longer ranges fall back to `D` with `footer.notes`).
2. **Primary series.** By variant: `equity`/`index`/`fx`/`crypto`(D/W/M) → `data.historical.bars(id, { start, end, periodicity: 'D', adjust: params.adjust, currency, fields: [PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME] })` then `resample` to W/M when requested; `meta.adjustments` ← the steps (REF-09). Intraday → `data.intraday.bars(id, { days: 1|2|5, interval, session:'regular' })` (sessions from the Yahoo `tradingPeriods`). `crypto` D/W/M: `bars_daily` has no crypto rows in v1 → the resolver resamples `quote_ticks` (`data.ticks.last(id, 45_000)`, 30-day retention) into daily closes and marks `o/h/l/v` from the ticks; `range` longer than `1M` → `unavailable.add({ field:'primary', reason:'NO_SOURCE', detail:'no daily history source for crypto (context only); showing captured ticks (≤ 30 d)' })`. `option` → `option_quotes` (`last` else mid) per capture, resampled to `5m`/`D`; older than the 10-day retention → same `NO_SOURCE` pattern (`detail:'option quotes retained 10 days'`). `govt` → `curve_points` history for `(curve_id, tenor)` = (`UST_BILL`, `term_label`, `quote_type='investment_yield'`) for bills or (`UST_PAR`, `term_label`) for notes/bonds, `unit:'yield'`; a CUSIP without `term_label` → `NO_SOURCE 'no price history for off-the-run Treasuries'`. `series` → rate: `rate_fixings` (`is_latest`, `unit:'rate'`); econ: `data.econ.observations(code, { from: start, to: end, knownAt })` (`unit` from `econ_series.units`: `'pct'` when units start with `Percent`, else `'index'`).
3. **Overlays** (CHRT-03): each `SecurityRefInput` → `data.reference.resolve` (404/409 become `unavailable.add({ field:'overlays[i]', reason:'NOT_APPLICABLE', detail: error.message })`, the overlay is dropped, never a 4xx for the whole chart); a formula ref → `core/formula` parse; its leaf refs are resolved and fetched as above; `evaluator.evaluate(ast, seriesByRef, { align: 'intersection' })` produces `c` only (`o/h/l/v = null`), engine `formula@1.0.0`. Overlays are fetched at the primary's periodicity and aligned on their own calendars (`calendarId` per series; the chart aligns by timestamp, gaps = NaN). `normalise` is applied client-side (the payload always carries raw levels so the CSV is the source data).
4. **Currency** (`params.currency`): each series whose `currency !== params.currency` is converted with `fx_rates` (`frankfurter`, per session date, previous available date when missing) → `converted`, `fx[]` block.
5. **Events** (CHRT-06), primary only, within `[start, end]`, capped at 500 total (oldest dropped, `footer.notes` says so): `earnings` ← `filings` form `8-K` with item `2.02` (fallback 10-Q/10-K `filed_date`), `command: '<key> CF'`; `dividend`/`split` ← `corporate_actions` as-of (`cash_dividend`, `special_dividend`, `split`, `reverse_split`, `stock_dividend`; label `'$0.26'`/`'4:1'`), `command: '<key> CACS'`; `news` (when `events.news`) ← `news_entity_links` for the instrument, ≤ 200, label = headline (≤ 60 chars), `command: '<key> CN'`; `filing` (when `events.filings`) ← `8-K` filings, `command: '<key> CF'`; `index_add`/`index_drop` ← `index_members` version boundaries for the instrument (`valid_from` = add, `valid_to` = drop) `command: '<indexKey> MEMB'`; `fomc` (series variant, rates only) ← `fomc_meetings.meeting_date`, `command: 'FED'`.
6. **Annotations** (CHRT-05): `chart_annotations WHERE instrument_id = id` under RLS (own + firm-shared + shared-with-me); `editable = owner_user_id === ctx.user.userId`.
7. `last = cellFromState(plant.snapshot('q:<id>'), 'PX_LAST')` (pending when no state); `reference` = prev close (`PX_CLOSE_1D`) for price variants, par yield for govt, strike for option.
8. Return; `window.bars = primary.t.length`. Budget: 1Y daily = 1 PK range scan (≈ 252 rows) + corporate actions + filings + annotations = 4 round-trips, < 200 ms p95 (NFR historical query); 10Y with 3 overlays < 600 ms.

#### Live
`live: (params, p) => p.primary.live === null && p.overlays.every(o => o.live === null) ? null : { subjects: [p.primary, ...p.overlays].filter(s => s.live).map(s => s.live!.subject), fields: p.window.periodicity === '1m' || p.window.periodicity === '5m' ? ['BAR_TS','PX_OPEN','PX_HIGH','PX_LOW','PX_LAST','PX_VOLUME','IS_FINAL'] : ['PX_LAST','PX_VOLUME','LAST_TRADE_TIME','PX_CLOSE_1D'], conflationMs: 500 }`.
`GpSeries.live.mode`: `'replace-last'` for D/W/M — the chart overwrites the last bar's close (and high/low extremes) with `PX_LAST` while `SESSION_STATE` is open (the day's bar is the forming bar, appended client-side when `t[last] < today`); `'append-forming-bar'` for 1m/5m — `b1m:` deltas update the forming bar and `IS_FINAL:true` seals it (CHRT-02: streaming without full re-render, `ChartCanvas` patches the series typed array in place). `last` is a live cell in the header.

#### Screen
`screenKind:'custom'`; the body is `split col [0.06 | 0.88 | 0.06]`: `badges#toolbar` (range chips `1D 5D 1M 3M 6M YTD 1Y 2Y 5Y 10Y MAX` with the active one highlighted, then `type`, `adjust`, `normalise`, `currency`, `log` badges and the overlay keys with `×`), `custom#chart` (`component:'PriceChart'`), `kv#footerStats` (last · chg · window high/low · bars · adjustments count · `events` count). Title `GP · <display> · <name>`; subtitle `<range> · <periodicity> · <adjust>` (`1Y · D · price`). `initialFocus: 'chart'`. Skeleton: toolbar with the params' chips and an empty chart frame with the title; no fake series.

`ChartSpec` built by `screens/GP/spec.ts` (§1.5 shape):
```ts
{
  kind: periodicity is intraday ? 'intraday' : 'price',
  xAxis: { type: 'time', tz: primary.tz, calendarId: primary.calendarId, sessions: primary.sessions ?? undefined },
  yAxes: [{ id: 'y', side: 'right', scale: params.logScale ? 'log' : 'linear', fmt: unitFmt(primary.unit), decimals: instrument?.priceDecimals, normalise: params.normalise },
          ...(overlays with a different unit or currency → one extra { id: 'y<i>', side: 'left', … } each, CHRT-03 independent axes)],
  panes: [{ id: 'main', height: params.volume ? 0.72 : 1 }, ...(params.volume && primary.v ? [{ id: 'vol', height: 0.13, title: 'Volume' }] : []), ...(sub studies → { id: 'st<i>', height: 0.15 / n })],
  series: [{ id: 'p', label: primary.label, type: params.type, pane: 'main', yAxis: 'y', x: primary.t, y: primary.c, ohlc: o/h/l/c typed arrays when present, volume: primary.v, provIdx, currency, calendarId, live: primary.live, style: { color: 'auto' } },
           ...overlays.map((o, i) => ({ id: 'o'+i, type: 'line', pane: 'main', yAxis: sameUnit ? 'y' : 'y'+i, x: o.t, y: o.c, … })),
           ...(volume pane → { id: 'v', type: 'bar', pane: 'vol', yAxis: 'vol', x: primary.t, y: primary.v })],
  studies: params.studies.map(s => ({ id: s.id, params: s.params, pane: s.pane === 'main' ? 'main' : 'st<i>', inputSeriesId: 'p' })),   // computed in web/chart/studies (CHRT-04)
  events: p.events.map(e => ({ t: e.t, kind: e.kind, label: e.label, command: e.command, provIdx: e.provIdx })),   // CHRT-06 click-through
  annotations: p.annotations.map(a => ({ annotationId: a.annotationId, kind: a.kind, anchors: a.anchors, label: a.label ?? undefined, editable: a.editable })),
  reference: p.reference.map(r => ({ yAxis: 'y', v: r.v, label: r.label })),
  crosshair: true, logScale: params.logScale,
  onEvent: e => e.kind === 'event' ? ctx.navigate(e.payload.command) : e.kind === 'annotation-save' ? sdk.workspace.annotations.create/update(...) : void 0,
}
```
`meta.entitlement` denials (e.g. `PX_LAST` for an eod-only user) leave the series as stored closes (`PX_OFFICIAL_CLOSE` path) and blank the live `last` cell with its reason badge; `meta.unavailable` renders as an amber badge in the toolbar with the detail (crypto/option history limits, dropped overlays). Study ids available in v1 (`web/chart/studies`): `SMA EMA WMA BB RSI MACD VWAP ATR STOCH OBV ROC MOM CCI ADX DONCHIAN KELTNER ICHIMOKU PSAR` (CHRT-04 subset; the picker lists them with their param defaults).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `ArrowLeft` / `ArrowRight` | chart | `crosshair-prev` / `crosshair-next` | move the crosshair one bar; the kv strip shows that bar's OHLCV and every overlay's value |
| `Shift+ArrowLeft` / `Shift+ArrowRight` | chart | `pan-left` / `pan-right` | pan by 10 % of the visible window |
| `+` / `-` | chart | `zoom-in` / `zoom-out` | zoom around the crosshair; zooming out past the loaded window widens the range via `setParams({ range: next })` |
| `Home` / `End` | chart | `crosshair-first` / `crosshair-last` | extremes |
| `R` | always | `cycle-range` | `setParams({ range: next in the chip order })` |
| `Shift+R` | always | `custom-range` | `ctx.prompt('date', { label:'Start' })` then `('date', { label:'End' })` → `setParams({ range:'CUSTOM', start, end })` |
| `T` | always | `cycle-type` | `setParams({ type: next })` (line → area → mountain → candle → ohlc → bar → step → pnf → profile → heatmap → tick) |
| `A` | always | `cycle-adjust` | `setParams({ adjust: next })` (price → total_return → unadjusted); footer shows the factor steps |
| `L` | always | `toggle-log` | `setParams({ logScale: !logScale })` |
| `N` | always | `cycle-normalise` | `setParams({ normalise: next })` |
| `P` | always | `cycle-periodicity` | `setParams({ periodicity: next allowed for the range })` |
| `V` | always | `toggle-volume` | `setParams({ volume: !volume })` |
| `O` | always | `add-overlay` | `ctx.prompt('security')` → `setParams({ overlays: [...overlays, ref] })` (max 5; footer error beyond) |
| `X` | always | `remove-overlay` | removes the last overlay (or the one focused in the toolbar) |
| `C` | always | `set-currency` | `ctx.prompt('text', { label:'Currency (ISO 4217)' })` → `setParams({ currency })` |
| `S` | always | `add-study` | `ctx.prompt('text', { label:'Study (SMA 20, RSI 14 …)' })` parsed as `<ID> <param…>` → `setParams({ studies: [...] })` |
| `Shift+S` | always | `remove-study` | removes the last study |
| `E` | always | `toggle-events` | toggles all event kinds (`setParams({ events })`) |
| `D` | chart | `draw-mode` | cycles draw tool none → trendline → hline → vline → fib → text → rect; anchors placed with `Enter` at the crosshair; `Escape` leaves draw mode (overlay priority of §2.6) |
| `Enter` | chart | `activate` | on an event marker under the crosshair → `ctx.navigate(event.command)`; in draw mode → place anchor; on an annotation → edit label (`prompt('text')`) |
| `Delete` | chart | `delete-annotation` | deletes the focused editable annotation (`sdk.workspace.annotations.remove`) |
| `Ctrl+S` | always | `save-annotations` | persists pending annotation edits (`create`/`update`); shared scope via `ctx.prompt('text', { label:'private | firm | users' })` |
| `G` | always | `open-gip` | `ctx.navigate('GIP')` |
| `H` | always | `open-hp` | `ctx.navigate('HP ' + range)` (same window) |

#### CSV
`filename = 'GP_' + displaySlug + '_' + range + '_' + asOfCompact + '.csv'` (`GP_AAPL_US_Equity_1Y_20260915T184128Z.csv`). Columns are payload-dependent (`csvColumns: null` in `FunctionManifestPublic`): `t,series,open,high,low,close,volume,currency,adjust` — one row per `(bar, series)` in series order (`primary` then overlays), `t` as ISO datetime (intraday) or `YYYY-MM-DD` (D/W/M), `open/high/low/volume` empty when the series has none, raw (un-normalised, converted-if-requested) values. Event markers follow the price rows as rows whose `series` is `'event'`, `t` is the event time, `open` = kind, `high` = label, `low` = command and `close`/`volume`/`currency`/`adjust` are empty (one table, §1.6 rule 3). Annotations are not exported (they are user drawings, not data). Studies are not exported (they are deterministic client-side transforms of the exported closes; the `# provenance` line names the study ids and params). Example: `2026-09-15,AAPL US Equity,330.24,331.59,328.35,330.27,16591786,USD,price`.

#### Help
summary `Price chart from intraday to multi-decade with overlays, events, studies and annotations`; description `GP charts the loaded security. Ranges 1D and 5D use 1- and 5-minute bars; longer ranges use daily bars resampled to weekly or monthly. Corporate actions are applied on read under the adjust policy shown in the toolbar (price: splits and capital changes; total_return: also cash dividends; unadjusted: raw closes); the factors used are listed in the footer. Overlays (VS=) are aligned on each security's own calendar and normalised to percent change or base 100 when their units differ; a formula such as <RATIO(AAPL US Equity, SPX Index)> can be charted or overlaid. Event markers come from SEC filings, corporate actions, index membership changes and FOMC dates; Enter on a marker opens its source function. Studies are computed in the client from the exported data. Annotations are saved server-side and can be shared with the firm. Treasuries chart the on-the-run tenor's yield; rates and economic series chart the published observations as known at the knownAt in the footer.`; params `range` ("1D 5D 1M 3M 6M YTD 1Y 2Y 5Y 10Y MAX, or two dates", `5Y`), `start`/`end` ("custom window", `2020-01-01 2020-12-31`), `periodicity` ("auto, 1m, 5m, D, W, M", `PER=W`), `type` ("line, area, mountain, candle, ohlc, bar, step, pnf, profile, heatmap, tick", `TYPE=CANDLE`), `adjust` ("price, total_return, unadjusted", `ADJ=TR`), `overlays` ("up to five VS= securities or formulas", `VS=MSFT US Equity`), `normalise` ("none, pct, base100", `NORM=BASE100`), `currency` ("convert with ECB reference rates", `CCY=EUR`), `studies` ("technical studies, S to add", `SMA 50`), `events` ("marker kinds", `E toggles`), `logScale` ("log y-axis", `LOG=1`), `volume` ("volume pane", `V toggles`); sources `['yahoo.chart','cboe.quotes','frankfurter','sec.submissions','sec.atom','sec.archives','ssga.holdings','fed.fomc','treasury.yieldcurve','treasury.bills','nyfed.rates','fred.csv','bls.timeseries','cboe.options','coingecko.simple','internal.derived']`; related `['GIP','HP','DES','CACS','CN','GC']`.

#### Unavailable and reason codes
| `field` | `reason` | `detail` |
| --- | --- | --- |
| `primary` | `NO_SOURCE` | `no daily history source for crypto (context only); showing captured ticks (≤ 30 d)` |
| `primary` | `NO_SOURCE` | `option quotes retained 10 days` |
| `primary` | `NO_SOURCE` | `no price history for off-the-run Treasuries` |
| `primary` | `NO_SOURCE` | `no bars in window` (empty result; the chart renders the empty frame, never a flat line) |
| `overlays[i]` | `NOT_APPLICABLE` | `<SECURITY_NOT_FOUND | AMBIGUOUS_SECURITY | NOT_IN_UNIVERSE message>` |
| `overlays[i]` | `NOT_APPLICABLE` | `formula parse error: <message>` |
| `events` | `NOT_APPLICABLE` | `capped at 500 markers; oldest dropped` |
| `fx` | `NO_SOURCE` | `no ECB rate for <ccy>` (conversion skipped for that series, `converted:null`) |
Footer notes: `Intraday ranges are limited to 5D; showing D` (clamp); entitlement: `PX_LAST` denied → the `last` cell blank with `TIER_EOD`; provider circuit open during a read-through → series from the store with `meta.staleness:'stale'` and the toolbar glyph.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/GP.golden.test.ts` | seven variants at the frozen clock (`AAPL 1Y D`, `SPX 5D 5m`, `EURUSD 1M`, `912797VE4`, option `1D`, `BTC 5D`, `DGS10 1Y`) equal `GP.<variant>.json`; `AAPL 2020-01-01 2020-12-31 ADJ=PRICE` has `adjustments[0] = { beforeDate:'2020-08-31', priceFactor:0.25, volumeFactor:4, kind:'split' }` and close `124.8075` on `2020-08-28` (REF-09 golden `fixtures/golden/analytics/adjust/aapl.json`); the same with `knownAt 2020-07-30` has no adjustment and close `499.23` (REF-03) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `GP.<variant>.csv`; every `close` equals `c[i]` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared |
| overlays and formula | `packages/server/test/integration/functions/GP.overlays.test.ts` | `VS=MSFT US Equity` without a recorded quote still returns the AAPL series (overlay dropped with `NOT_APPLICABLE`), `<RATIO(AAPL US Equity, SPX Index)>` yields `formula !== null`, `o === null`, engine `formula@1.0.0`, aligned on the intersection of dates (CHRT-07, CHRT-03) |
| events | `packages/server/test/integration/functions/GP.events.test.ts` | AAPL 5Y contains 20 `dividend` markers, `earnings` markers from 8-K 2.02, `index_add` absent (member since before window); `fomc` markers only in the `series` variant |
| screen / chart | `packages/web/test/screens/GP.test.tsx`, `packages/web/test/chart/streaming.test.ts` | ChartSpec shape per variant; `T/A/L/N/R` call `setParams`; a `b1m` delta with `IS_FINAL:false` mutates the last bar in place, `IS_FINAL:true` appends (CHRT-02); crosshair keys move by one bar |
| e2e | `packages/e2e/tests/chart.spec.ts` | `AAPL US Equity GP 5Y TYPE=CANDLE <GO>` paints candles within 500 ms; `A` cycles to `total_return` and the footer lists factors; `O` + `SPX Index` adds an overlay on a second axis; `Enter` on a dividend marker opens CACS; `D`, two `Enter`s and `Ctrl+S` persist a trendline that survives reload (CHRT-05) |

---

### GIP — Intraday Price Graph

| Attribute | Value |
| --- | --- |
| Code / aliases | `GIP` / `INTRA` |
| Tier / category | 1 / charting |
| Asset classes → variants | `equity, etf, index, fx, crypto, option → intraday` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `custom` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/GIP.ts` · `packages/server/src/functions/GIP/resolve.ts` · `packages/web/src/screens/GIP/Screen.tsx` · `fixtures/golden/functions/GIP.intraday.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (CHRT-01) (CHRT-02) (FEED-05) (FEED-06) (BUS-01) (BUS-03) (TERM-06) (TERM-12) (DATA-10) (ENTL-05) |

#### Params
```ts
export const GipParams = z.object({
  days: z.enum(['1', '2', '5']).default('1'),
  interval: z.enum(['1m', '5m']).default('1m'),                 // 5D forces 5m
  session: z.enum(['regular', 'extended']).default('regular'),
  vwap: z.boolean().default(true),
  prevClose: z.boolean().default(true),
  volume: z.boolean().default(true),
});
```
#### Argument grammar
`positional [{ name:'days', type:'enum', values:['1','2','5'], optional:true }, { name:'interval', type:'enum', values:['1m','5m'], optional:true }]`, `keyed { SESS: { name:'session', type:'enum', values:['regular','extended'] }, VWAP: { name:'vwap', type:'boolean' } }`, no `rest`.
Examples: `GIP` → `{ days:'1', interval:'1m', session:'regular', vwap:true, prevClose:true, volume:true }` · `GIP 5` → `{ days:'5', interval:'5m' }` (resolver forces `5m` for five days; `meta` echoes the effective interval in `payload.interval`) · `GIP 1 SESS=EXTENDED VWAP=N` → `{ days:'1', session:'extended', vwap:false }`.

#### Payload
```ts
export type GipPayload = {
  variant: 'intraday';
  instrument: InstrumentSummary;
  interval: '1m' | '5m'; days: 1 | 2 | 5; tz: string; calendarId: string;
  bars: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; provIdx: number };   // ascending, final bars only
  forming: { t: number; o: number; h: number; l: number; c: number; v: number; isFinal: false; provIdx: number } | null;   // from b1m:<id> at resolve time
  sessions: Array<{ start: number; end: number; kind: 'pre' | 'regular' | 'post'; date: string }>;
  vwap: number[] | null;                                          // cumulative per session, aligned to bars.t (NaN outside regular session)
  prevClose: ValueCell;                                           // PX_CLOSE_1D (plant) — the reference line
  stats: { open: ValueCell; high: ValueCell; low: ValueCell; last: ValueCell; chgNet: ValueCell; chgPct: ValueCell; volume: ValueCell; vwapNow: ValueCell; pctOfAvgVolume30d: ValueCell; sessionState: ValueCell };
  sourceLine: { mdLineId: number; sourceId: string; providerSymbol: string; intrinsicDelayMin: number };
};
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `bars_intraday` (`bar_interval`, `session`, `is_final`), `bars_daily` (30-day average volume), `md_lines`, `calendars` + `calendar_sessions` + `calendar_holidays` (FEED-06), `quote_snapshots` (plant) |
| Data services | `data.intraday.bars`, `data.historical.bars`, `plant.snapshot`, `plant.subjectFor`, `plant.ensureHot` |
| Read-through | `('yahoo.intraday', providerSymbol, { maxAgeMs: 60_000 })` when the newest stored final bar is older than `2 × interval` during an open session, or when no bars exist for the window; `('yahoo.fx', …)` for fx; `('coingecko.simple', …)` is not used (crypto intraday bars come from `quote_ticks` resampled: `data.ticks.last(id, 1500)`) |
| Engines | `vwap@1.0.0` (`core/analytics/stats#vwap`: cumulative Σ(typical price × volume)/Σvolume per session, typical price = (h+l+c)/3), `stats@1.0.0` |
| Subjects (live) | `b1m:<instrumentId>`, `q:<instrumentId>` |
| Field ids | all listed classes: `[BAR_TS, PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME, IS_FINAL, PX_CLOSE_1D, CHG_NET_1D, CHG_PCT_1D, VWAP, SESSION_STATE, VOLUME_AVG_30D]` (option adds nothing; fx/index have `PX_VOLUME` `na`) |

#### Resolver
1. `detail` prologue as DES; `calendar` from the primary listing's exchange (`XNAS`/`XNYS`/`XCBO`; `FX_USD` for fx; `WEEKEND` for crypto). `days = Number(params.days)`, `interval = days === 5 ? '5m' : params.interval`.
2. Session windows: `sessions` = for each of the last `days` trading days (`core/calendars#isBusinessDay`, ending at `asOfDate` in the calendar's tz) the `calendar_sessions` template (`pre_open→open_time` as `pre`, `open→close` as `regular`, `close→post_close` as `post`; early closes from `calendar_holidays.close_time`), converted to epoch ms.
3. Freshness: `state = plant.snapshot('q:<id>')`; if `state.session === 'open'` and the newest stored final bar is older than `2 × interval`, or there are no bars for the window: `await providers.ensure('yahoo.intraday', providerSymbol, { maxAgeMs: 60_000 })` (one call; the adapter persists `bars_intraday` with `is_final=false` on the last bar and feeds `b1m:`).
4. `bars = await data.intraday.bars(id, { days, interval, session: params.session })` — `is_final = true` rows only, `session ∈ ('regular')` or all three for `extended`; `forming` = the `b1m:<id>` state (`BAR_TS, PX_OPEN…PX_VOLUME, IS_FINAL:false`) when present.
5. `vwap` = `vwap(bars, sessions)` per regular session (null when `params.vwap === false` or the instrument has no volume — index/fx → `null` + `unavailable.add({ field:'vwap', reason:'NOT_APPLICABLE', detail:'no volume for this instrument' })`).
6. `prevClose = cellFromState(state, 'PX_CLOSE_1D')`; `stats.open/high/low/last/chgNet/chgPct/volume/sessionState` from the plant (`PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_VOLUME, SESSION_STATE`); `vwapNow` = last non-NaN vwap (derived, `provIdx` of bars); `pctOfAvgVolume30d = PX_VOLUME / VOLUME_AVG_30D × 100` with `VOLUME_AVG_30D` from `bars_daily` (30 sessions) — `st:'na'` when no volume.
7. Return. Budget: 2 DB round-trips (intraday PK range on one monthly partition ≈ 390 rows/day; daily volume) + plant; < 150 ms p95 warm; one 60-s read-through when cold.

#### Live
`{ subjects: ['b1m:<id>', 'q:<id>'], fields: ['BAR_TS','PX_OPEN','PX_HIGH','PX_LOW','PX_LAST','PX_VOLUME','IS_FINAL','PX_CLOSE_1D','CHG_NET_1D','CHG_PCT_1D','SESSION_STATE'], conflationMs: 250, essential: ['q:<id>'] }` (rule §0.4.5 splits the fields per subject). The chart's primary series declares `live: { subject:'b1m:<id>', field:'PX_LAST', mode:'append-forming-bar' }`: a delta with `IS_FINAL:false` patches the forming bar (o/h/l/c/v), `IS_FINAL:true` seals it and the next `BAR_TS` opens a new bar; `vwap` is extended client-side from the same deltas (`web/chart/studies/vwap.ts` uses the same function as core). `stats.*` cells follow `q:<id>`.

#### Screen
Title `GIP · <display> · <name>`; subtitle `<days>D · <interval> · <session> · <tz>`. `initialFocus:'chart'`. Body `split col [0.08 | 0.80 | 0.12]`: `kv#stats` (one row of live cells: Last · Chg · Chg% · Open · High · Low · VWAP · Volume · % of 30-d avg · session badge) — `custom#chart` (`PriceChart`) — `badges#toolbar` (`1D 2D 5D` chips, `1m/5m`, `regular/extended`, VWAP on/off, prev-close on/off, source line + delay `Yahoo · 15 min`). Skeleton: the stats row with `—` and an empty chart frame carrying the session boundaries.
`ChartSpec`: `{ kind:'intraday', xAxis: { type:'time', tz, calendarId, sessions }, yAxes: [{ id:'y', side:'right', scale:'linear', fmt:'px', decimals: priceDecimals }, { id:'vol', side:'left', scale:'linear', fmt:'int' }], panes: [{ id:'main', height: volume ? 0.78 : 1 }, { id:'vol', height: 0.22, title:'Volume' }], series: [{ id:'p', type:'candle', pane:'main', yAxis:'y', x: t, y: c, ohlc, volume: v, provIdx, live: { subject:'b1m:<id>', field:'PX_LAST', mode:'append-forming-bar' } }, { id:'vwap', type:'line', pane:'main', yAxis:'y', x: t, y: vwap, style: { color:'neutral', dashed:true } } (when vwap), { id:'v', type:'bar', pane:'vol', yAxis:'vol', x: t, y: v }], reference: prevClose ? [{ yAxis:'y', v: prevClose.v, label:'prev close' }] : [], crosshair: true }`. The x-axis draws session bands (`pre`/`post` shaded) and gaps between days are collapsed (FEED-06). Entitlement: `eod`-only users see `stats.*` blank with `TIER_EOD` and the chart from stored bars only; `meta.unavailable.vwap` hides the VWAP chip with the detail as tooltip.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `ArrowLeft` / `ArrowRight` | chart | `crosshair-prev` / `crosshair-next` | one bar; the stats row shows the bar under the crosshair (`Home`/`End` extremes) |
| `Shift+ArrowLeft` / `Shift+ArrowRight` | chart | `pan-left` / `pan-right` | pan by one hour |
| `+` / `-` | chart | `zoom-in` / `zoom-out` | zoom around the crosshair |
| `1` / `2` / `5` | always | `days-1` / `days-2` / `days-5` | `setParams({ days })` |
| `I` | always | `toggle-interval` | `setParams({ interval: interval === '1m' ? '5m' : '1m' })` |
| `X` | always | `toggle-session` | `setParams({ session: next })` |
| `V` | always | `toggle-vwap` | `setParams({ vwap: !vwap })` |
| `C` | always | `toggle-prevclose` | `setParams({ prevClose: !prevClose })` |
| `B` | always | `toggle-volume` | `setParams({ volume: !volume })` |
| `T` | always | `cycle-type` | candle → ohlc → line → area (client-only display toggle; not a param, not exported) |
| `G` | always | `open-gp` | `ctx.navigate('GP')` |
| `Q` | always | `open-q` | `ctx.navigate('Q')` |
| `Enter` | chart | `open-q` | `ctx.navigate('Q')` (tape at the crosshair time is a Q feature) |

#### CSV
`filename = 'GIP_' + displaySlug + '_' + days + 'D' + interval + '_' + asOfCompact + '.csv'`. Static columns `t,open,high,low,close,volume,vwap,session` — one row per final bar (`t` ISO UTC, `vwap` empty outside regular sessions or when null), then the forming bar as a final row with `session` = `forming` (it is what the screen shows). Example: `2026-09-15T13:30:00Z,330.260009765625,331.1300048828125,328.3500061035156,331.0299987792969,1296997,330.17,regular`.

#### Help
summary `Intraday chart: 1- or 5-minute bars with VWAP, sessions and the forming bar streamed`; description `GIP charts the current session (or the last two or five) at one- or five-minute resolution from the Yahoo chart feed (15 minutes delayed at source). The last bar is the forming bar and updates from the ticker plant until it is sealed; VWAP is cumulative per regular session; pre- and post-market bars are included with SESS=EXTENDED. The previous close is drawn as a reference line. Indices and FX have no volume, so VWAP and the volume pane are not applicable. Crypto intraday bars are built from the captured CoinGecko polls and are context only.`; params `days` ("1, 2 or 5 trading days", `5`), `interval` ("1m or 5m (5D forces 5m)", `5m`), `session` ("regular or extended hours", `SESS=EXTENDED`), `vwap` ("draw VWAP", `VWAP=N`), `prevClose` ("draw previous close", `C toggles`), `volume` ("volume pane", `B toggles`); sources `['yahoo.chart','cboe.quotes','coingecko.simple','internal.derived']`; related `['GP','Q','DES','HP']`.

#### Unavailable and reason codes
`{ field:'vwap', reason:'NOT_APPLICABLE', detail:'no volume for this instrument' }` (index, fx); `{ field:'bars', reason:'NO_SOURCE', detail:'no intraday bars in window (holiday or provider outage)' }` when the window has zero bars — the chart shows the session frame only; `{ field:'stats.pctOfAvgVolume30d', reason:'NO_SOURCE', detail:'fewer than 5 daily bars' }`; crypto: `{ field:'bars', reason:'NO_SOURCE', detail:'intraday bars resampled from 60-second polls; context only' }`. Entitlement `TIER_EOD` blanks every `stats.*` cell; `PROVIDER_DOWN` (circuit open) → bars from the store, `meta.staleness:'stale'`, forming bar dropped (never a frozen "live" bar, TERM-12).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/GIP.golden.test.ts` | `AAPL US Equity GIP` at the frozen clock equals `GIP.intraday.json` (317 bars from `yahoo-chart-AAPL-1d-1m.json`, the last one `forming`), `sessions[0] = { start: 1789479000000, end: 1789502400000, kind:'regular' }`; `SPX Index GIP 5` has `vwap === null` with the `NOT_APPLICABLE` note |
| vwap | `packages/core/test/analytics/vwap.test.ts` | golden `fixtures/golden/analytics/vwap/aapl-2026-09-15.json` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `GIP.intraday.csv` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared |
| screen / streaming | `packages/web/test/screens/GIP.test.tsx` | forming bar patched in place on `IS_FINAL:false`, appended on `IS_FINAL:true`; session bands drawn; `1/2/5` call `setParams`; skeleton |
| e2e | `packages/e2e/tests/quote.spec.ts` (GIP section) | `AAPL US Equity GIP <GO>` paints within 500 ms; replayed `b1m` deltas move the last candle; `V` hides VWAP |

---

### HP — Historical Price Table

| Attribute | Value |
| --- | --- |
| Code / aliases | `HP` / `HIST` |
| Tier / category | 1 / pricing |
| Asset classes → variants | `equity, etf, index, fx, crypto → price; govt, rate, econ → series` |
| requiresSecurity / pageable / screenKind | `true` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/HP.ts` · `packages/server/src/functions/HP/resolve.ts` (+ `series.ts`) · `packages/web/src/screens/HP/Screen.tsx` · `fixtures/golden/functions/HP.{price,series}.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (REF-03) (REF-06) (REF-09) (STOR-02) (STOR-06) (API-05) (TERM-06) (TERM-07) (TERM-12) (DATA-10) (ENTL-05) |

#### Params
```ts
export const HpParams = z.object({
  range: z.enum(['1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'MAX', 'CUSTOM']).default('1Y'),
  start: z.iso.date().optional(), end: z.iso.date().optional(),
  periodicity: Periodicity.default('D'),                                             // D W M Q Y
  adjust: AdjustPolicy.default('price'),
  currency: z.string().length(3).optional(),
  fields: z.array(z.enum(['PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME', 'VWAP', 'PX_OFFICIAL_CLOSE', 'CHG_NET_1D', 'CHG_PCT_1D', 'TOT_RETURN_INDEX'])).min(1).max(10)
          .default(['PX_LAST', 'PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_VOLUME', 'CHG_PCT_1D']),
  order: z.enum(['desc', 'asc']).default('desc'),
  pageSize: z.number().int().min(20).max(500).default(60),
});
```
#### Argument grammar
`positional [{ name:'range', type:'range', optional:true }, { name:'start', type:'date', optional:true }, { name:'end', type:'date', optional:true }, { name:'periodicity', type:'enum', values:['D','W','M','Q','Y'], optional:true }]`, `keyed { ADJ: { name:'adjust', type:'enum', values:['unadjusted','price','total_return'] }, CCY: { name:'currency', type:'currency' }, FLDS: { name:'fields', type:'string' } /* comma-separated field ids */, ORDER: { name:'order', type:'enum', values:['desc','asc'] }, N: { name:'pageSize', type:'int' } }`, no `rest`. Short aliases `ADJ=TR|PX|UN` as GP.
Examples: `HP` → `{ range:'1Y', periodicity:'D', adjust:'price', fields:[defaults], order:'desc', pageSize:60 }` · `HP W` → `{ periodicity:'W' }` (the token fails `range` and fills the optional `periodicity` slot, §2.4 rule 2) · `BBG000B9XRY4 HP 2020-01-01 2020-12-31 W` → `{ range:'CUSTOM', start:'2020-01-01', end:'2020-12-31', periodicity:'W' }`.

#### Payload
```ts
export type HpPayload =
  | { variant: 'price'; instrument: InstrumentSummary;
      columns: Array<{ id: FieldId; label: string; fmt: 'px' | 'pct' | 'int' | 'shares'; decimals: number | null }>;   // in params.fields order
      rows: Array<{ date: string; v: Array<number | null>; adjFactor: number; volumeFactor: number; sessions: number }>;   // page; sessions = bars aggregated into the row (1 for D)
      summary: { first: number | null; last: number | null; high: number | null; highDate: string | null; low: number | null; lowDate: string | null;
                 priceReturnPct: number | null; totalReturnPct: number | null; avgVolume: number | null; bars: number; firstDate: string | null; lastDate: string | null };   // over the whole window, not the page
      window: { start: string; end: string; range: HpParams['range'] }; periodicity: 'D' | 'W' | 'M' | 'Q' | 'Y'; adjust: AdjustPolicy;
      currency: string; converted: { from: string; to: string } | null; calendarId: string; sessionOpen: boolean; provIdx: number[] }
  | { variant: 'series'; instrument: InstrumentSummary;
      series: { kind: 'govt' | 'rate' | 'econ'; code: string; name: string; units: string; frequency: 'D' | 'W' | 'M' | 'Q' | 'A'; sourceId: string; curveId: string | null; tenor: string | null };
      columns: Array<{ id: FieldId; label: string; fmt: 'pct' | 'px' | 'int'; decimals: number }>;               // rate: RATE, RATE_P1, RATE_P25, RATE_P75, RATE_P99, RATE_VOLUME_BN; govt bill: DISC_RATE, BEY; govt note: CRV tenor par (id 'CRV_<tenor>'); econ: ECO_VALUE
      rows: Array<{ date: string; v: Array<number | null>; status: 'final' | 'preliminary' | 'revised' | 'missing' | null; vintageAt: string | null; chgAbs: number | null; chgPct: number | null }>;
      summary: { first: number | null; last: number | null; high: number | null; highDate: string | null; low: number | null; lowDate: string | null; changeAbs: number | null; changePct: number | null; observations: number };
      window: { start: string; end: string; range: HpParams['range'] }; periodicity: 'D' | 'W' | 'M' | 'Q' | 'Y'; knownAt: string; provIdx: number[] };
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `bars_daily` (unadjusted), `corporate_actions` (as-of `ctx.asOf`), `fx_rates`, `calendars`/`calendar_holidays` (roll-ups), `curve_points` (govt), `rate_fixings` (rate), `econ_observations` + `econ_series` (econ, PIT by `vintage_at ≤ knownAt`), `quote_snapshots` (session flag only) |
| Data services | `data.historical.bars` (does resampling, adjustment, currency), `data.curves.points` / `/curves/:id/history` reader (`data.curves.history(curveId, tenor, from, to, quoteType)` — added to `curves` service for HP/GP govt), `data.rates.history`, `data.econ.observations`, `plant.snapshot` |
| Read-through | `('yahoo.daily', providerSymbol, { maxAgeMs: 6*3600e3 })` when `bars_daily` lacks any session in `[start, end]` newer than the last stored session + 1 (backfill on first use); none for `series` |
| Engines | `adjust@1.0.0`, `resample@1.0.0`, `totalReturn@1.0.0` (`core/adjust/corporateActions.ts#totalReturnIndex` for `TOT_RETURN_INDEX` and `summary.totalReturnPct`), `stats@1.0.0` (`CHG_NET_1D`/`CHG_PCT_1D` between consecutive rows of the chosen periodicity) |
| Subjects (live) | None. (Decision: HP shows completed sessions only so that the CSV equals the screen exactly; the open session is signalled by `sessionOpen` and the §0.4.6 footer note.) |
| Field ids | `price`: `[PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME, VWAP, PX_OFFICIAL_CLOSE, CHG_NET_1D, CHG_PCT_1D, TOT_RETURN_INDEX]` · `series`: govt `[CRV_1M, DISC_RATE, BEY]`, rate `[RATE, RATE_P1, RATE_P25, RATE_P75, RATE_P99, RATE_VOLUME_BN]`, econ `[ECO_VALUE, ECO_VINTAGE]` |

#### Resolver
1. Window as GP step 1 (`CUSTOM` needs `start`; `end` defaults to the last completed session ≤ `asOfDate` on the instrument's calendar — the open session is excluded: `sessionOpen = plant.snapshot('q:<id>')?.session === 'open'`).
2. **price**: `block = await data.historical.bars(id, { start, end, periodicity, adjust, currency, fields: params.fields })` — the service loads unadjusted `bars_daily` for `[start − 1 session, end]`, corporate actions as-of `ctx.asOf` (so `knownAt` before a split's `tx_from` yields unadjusted history — REF-03 + REF-09), computes `FactorStep[]` (`meta.adjustments`), applies `applyAdjustment`, resamples W/M/Q/Y (last session of ISO week / calendar month / quarter / year; open first, high max, low min, close last, volume sum, `VWAP` volume-weighted, `PX_OFFICIAL_CLOSE` last), converts currency at each row date via `fx_rates`, and computes `CHG_NET_1D`/`CHG_PCT_1D` versus the previous row and `TOT_RETURN_INDEX` (base 1 at the first row of the window) when requested. `rows[i].adjFactor` = cumulative price factor applied to that row (1 when none), `volumeFactor` likewise.
3. `summary` over the whole window (`first`/`last` closes, `high`/`low` of `PX_HIGH`/`PX_LOW` with dates, `priceReturnPct = last/first − 1`, `totalReturnPct` from `totalReturnIndex` with dividends as-of (null when `adjust === 'unadjusted'` and no dividends), `avgVolume`).
4. **Paging** (`pageable:true`): rows are ordered by `params.order`; the page is `pageSize` rows from the cursor; `cursor = base64url(JSON.stringify({ date: lastRowDate }))`; PAGE FWD = the next `pageSize` rows in the current order (older when `desc`), PAGE BACK = previous; `ctx.page.set({ index, count: ceil(totalRows / pageSize), cursor })`. The service returns the whole window once (≤ 10 y × 252 = 2 520 rows, one partition-pruned scan); paging is in memory on the result and the summary is stable across pages.
5. **series**: govt → `series.kind='govt'`, `curveId/tenor` from `govt_terms.term_label` (`UST_BILL` + `discount_rate`/`investment_yield` for bills → columns `DISC_RATE, BEY`; `UST_PAR` for notes/bonds → one column `CRV_<tenor>`), rows from `curve_points` `is_latest` (or `vintage_at ≤ knownAt`) in `[start, end]`; no `term_label` → `unavailable.add({ field:'rows', reason:'NO_SOURCE', detail:'no price history for off-the-run Treasuries' })` and empty rows. rate → `rate_fixings` history (`RATE` + percentiles + volume). econ → `data.econ.observations(code, { from, to, knownAt })` (`DISTINCT ON (obs_date)` with `vintage_at ≤ knownAt`), `status`, `vintageAt`, `chgAbs/chgPct` vs the previous observation; W/M/Q/Y periodicity on a daily series = last observation of the period; a monthly series with `periodicity:'D'` is served as-is (`footer.notes`: `series is monthly; periodicity D shown as M`).
6. Return. Budget: 1 y daily < 200 ms p95 (NFR), 10 y daily < 400 ms; 2 DB round-trips (bars, corporate actions) + 1 for `fx_rates` when converting.

#### Live
`null` (static screen). The shell's footer carries the §0.4.6 note when `sessionOpen`.

#### Screen
Title `HP · <display> · <name>`; subtitle `<range> · <periodicity> · <adjust> · <currency>`; `initialFocus:'rows'`. Body `split col [0.07 | 0.83 | 0.10]`: `badges#toolbar` (range chips, periodicity `D W M Q Y`, adjust, currency, order, `converted` badge, `sessionOpen` amber badge) — `grid#rows` (`frozenColumns: 1`: `date`, then one column per `columns[]` with `fmt`/`decimals` from the dictionary, `CHG_*` coloured by sign, `adjFactor` as a muted trailing column when ≠ 1; `page: { index, count }`; `sort` fixed by `order`) — `kv#summary` (3 columns: first/last/return, high/low with dates, total return/avg volume/bars). `series` variant: same shape with `status`/`vintageAt` columns and `knownAt` in the footer. Skeleton: toolbar from params, grid header row, 10 muted rows. `meta.adjustments` renders as a `badges#adjustments` row (`4:1 split before 2020-08-31 ×0.25`); `meta.entitlement` denials abort nothing here (historical fields are `eod`-servable) except `VWAP`/`PX_VOLUME` for a firm without the `yahoo.chart` grant → whole column `—` with the reason; `meta.unavailable` → amber badge with detail.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `PageDown` / `PageUp` | always | reserved PAGE FWD / BACK | `ctx.page('fwd')` / `ctx.page('back')` (older / newer when `order:'desc'`) |
| `A` | always | `cycle-adjust` | `setParams({ adjust: next })` |
| `P` | always | `cycle-periodicity` | `setParams({ periodicity: next of D W M Q Y })` |
| `R` | always | `cycle-range` | `setParams({ range: next })` |
| `Shift+R` | always | `custom-range` | two `ctx.prompt('date')` → `setParams({ range:'CUSTOM', start, end })` |
| `F` | always | `pick-fields` | `ctx.prompt('field', { label:'Add column' })` → `setParams({ fields: [...fields, id] })` (max 10) |
| `Shift+F` | always | `remove-field` | removes the focused column (min 1) |
| `C` | always | `set-currency` | `ctx.prompt('text', { label:'Currency' })` → `setParams({ currency })` |
| `O` | always | `toggle-order` | `setParams({ order: order === 'desc' ? 'asc' : 'desc' })` |
| `Enter` | grid | `open-gp-at` | `ctx.navigate('GP CUSTOM ' + (date − 3M) + ' ' + (date + 3M))` — GP centred on the row's date |
| `Shift+Enter` | grid | `open-gp-at-next` | same in the next panel |
| `G` | always | `open-gp` | `ctx.navigate('GP ' + range)` |
| `D` | always | `open-des` | `ctx.navigate('DES')` |
| `Ctrl+I` | grid | reserved | provenance of the focused cell (`provIdx[0]`) |

#### CSV
`filename = 'HP_' + displaySlug + '_' + asOfCompact + '.csv'` (`HP_AAPL_US_Equity_20260915T184128Z.csv`, API.md §9 example). Columns are payload-dependent: `date` + `columns[].id` + `adjFactor` (price) or `date` + `columns[].id` + `status,vintageAt,chgAbs,chgPct` (series). Rows: **the whole window** in `params.order` (not only the current page — the cached result holds every row; `meta.page` is ignored by `toCsv`), values at full precision. Example (price): `2026-09-15,330.27,330.24,331.59,328.35,16591786,-0.8436,1`.

#### Help
summary `Historical price table at any periodicity and adjustment basis, exportable`; description `HP lists closed sessions for the loaded security: daily, weekly, monthly, quarterly or yearly rows built from unadjusted daily bars with corporate actions applied on read (A cycles price, total return and unadjusted; the factors used are shown above the table and in the CSV header). Columns are chosen with F from the price fields of the dictionary; currency conversion uses ECB reference rates at each date. The current session is never included — it appears after the close. Treasuries show the on-the-run tenor's curve history, rates show fixings with percentiles and volume, economic series show observations as known at the knownAt shown in the footer (revisions are separate vintages). PRINT exports every row of the window with the same numbers.`; params `range` ("1M … MAX, or CUSTOM with two dates", `5Y`), `start`/`end` ("custom window", `2020-01-01 2020-12-31`), `periodicity` ("D W M Q Y", `W`), `adjust` ("price, total_return, unadjusted", `ADJ=TR`), `currency` ("ISO code", `CCY=EUR`), `fields` ("comma-separated price field ids", `FLDS=PX_LAST,PX_VOLUME`), `order` ("desc or asc", `ORDER=ASC`), `pageSize` ("rows per page 20–500", `N=100`); sources `['yahoo.chart','frankfurter','treasury.yieldcurve','treasury.bills','nyfed.rates','fred.csv','bls.timeseries','worldbank','imf.datamapper','internal.derived']`; related `['GP','DES','CACS','GIP']`.

#### Unavailable and reason codes
`{ field:'rows', reason:'NO_SOURCE', detail:'no daily bars in window' }` (empty window; also crypto for any range: `'no daily history source for crypto (context only)'`, option is not an HP asset class → `422 FUNCTION_NOT_APPLICABLE`); `{ field:'rows', reason:'NO_SOURCE', detail:'no price history for off-the-run Treasuries' }`; `{ field:'converted', reason:'NO_SOURCE', detail:'no ECB rate for <ccy>' }` (rows served unconverted, `converted:null`); `{ field:'summary.totalReturnPct', reason:'NOT_APPLICABLE', detail:'no dividend history' }`. Footer notes: §0.4.6 session-open note; `series is monthly; periodicity D shown as M`. Entitlement: `LICENCE_FORBIDS_USAGE` on export (a source with `export_allowed=false`) → `403 ENTITLEMENT_DENIED` from PRINT with the reason in the footer (FUNC-03).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/HP.golden.test.ts` | `AAPL US Equity HP` (1Y D) equals `HP.price.json`; `DGS10 Index HP 1Y` equals `HP.series.json`; `912797VE4 Govt HP` has columns `DISC_RATE, BEY` and 9 rows from `treasury-bills.xml` |
| adjust policies | `packages/server/test/integration/functions/HP.adjust.test.ts` | `AAPL HP 2020-08-01 2020-09-30 D ADJ=PX` row `2020-08-28` = `124.8075` with `adjFactor 0.25`; `ADJ=UN` = `499.23`, `adjFactor 1`; `ADJ=TR` on `2021-11-01…2021-11-10` applies the `0.22` dividend factor `1 − 0.22/closeBeforeEx`; `knownAt 2020-07-30` → no adjustment (REF-03/REF-09) |
| paging | `packages/server/test/integration/functions/HP.page.test.ts` | `pageSize 60` on 1Y: `meta.page.count === 5`, PAGE FWD cursor decodes to the last date of page 1, PAGE BACK returns page 1 again; the summary is identical on every page |
| resample | `packages/core/test/analytics/resample.test.ts` | W/M/Q/Y roll-ups on the AAPL 5-y fixture (open first, high max, low min, close last, volume sum) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `HP.price.csv`, `HP.series.csv`; the CSV has every window row |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = `/data/history` (`kind:'historical'`) for the same window and adjust (API-05) |
| screen | `packages/web/test/screens/HP.test.tsx` | grid columns follow `columns[]`; `A/P/R/F/O` call `setParams`; `PageDown` calls `ctx.page('fwd')`; adjustments badge; skeleton |
| e2e | `packages/e2e/tests/export.spec.ts` | `AAPL US Equity HP 1M <GO>`, `Ctrl+P` downloads `HP_AAPL_US_Equity_*.csv` whose numeric cells equal the grid's rendered values after formatting (FUNC-03, API-05); `eod@demo` exports successfully (historical fields are eod-servable) |

---

### Q — Quote

| Attribute | Value |
| --- | --- |
| Code / aliases | `Q` / `QUOTE`, `QR` |
| Tier / category | 1 / pricing |
| Asset classes → variants | `equity, etf, index, fx, option, crypto, rate → quote` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/Q.ts` · `packages/server/src/functions/Q/resolve.ts` · `packages/web/src/screens/Q/Screen.tsx` · `fixtures/golden/functions/Q.quote.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (FEED-03) (FEED-05) (FEED-06) (FEED-07) (BUS-01) (BUS-02) (BUS-03) (BUS-05) (BUS-06) (STOR-01) (TERM-06) (TERM-08) (TERM-11) (TERM-12) (DATA-10) (ENTL-05) (OPS-03) |

#### Params
```ts
export const QParams = z.object({
  depth: z.number().int().min(1).max(10).default(5),            // book levels requested; v1 sources publish 1 (top of book)
  tapeRows: z.number().int().min(10).max(200).default(30),
  view: z.enum(['composite', 'lines', 'tape']).default('composite'),
});
```
#### Argument grammar
`positional [{ name:'depth', type:'int', optional:true }]`, `keyed { TAPE: { name:'tapeRows', type:'int' }, VIEW: { name:'view', type:'enum', values:['composite','lines','tape'] } }`, no `rest`.
Examples: `Q` → `{ depth:5, tapeRows:30, view:'composite' }` · `Q 10` → `{ depth:10 }` · `AAPL US Equity Q TAPE=100 VIEW=TAPE` → `{ tapeRows:100, view:'tape' }`.

#### Payload
```ts
export type QCells = Partial<Record<FieldId, ValueCell>>;      // keyed by the QuoteFields of the asset class (§0.4 rule 1)
export type QPayload = {
  variant: 'quote';
  instrument: InstrumentSummary;
  composite: QCells;                                              // PX_LAST LAST_SIZE LAST_TRADE_TIME PX_BID PX_ASK BID_SIZE ASK_SIZE PX_OPEN PX_HIGH PX_LOW PX_CLOSE_1D PX_OFFICIAL_CLOSE PX_VOLUME VWAP CHG_NET_1D CHG_PCT_1D TICK_DIR IVOL_30D SESSION_STATE (+ OPT_* for option, RATE_* for rate)
  compositeTs: { src: string | null; cap: string; pub: string }; // FEED-05, ISO
  compositeSeq: number; tier: Tier; delayMin: number;
  lines: Array<{ mdLineId: number; sourceId: string; providerSymbol: string; lineKind: 'composite' | 'venue' | 'derived' | 'reference'; priority: number; intrinsicDelayMin: number; expectedIntervalMs: number;
                 subject: string /* 'l:<mdLineId>' */; cells: QCells; ts: { src: string | null; cap: string; pub: string }; srcSeq: number | null; st: ValueState; provIdx: number }>;
  book: { bids: Array<{ px: number; size: number; venue: string | null; provIdx: number }>; asks: Array<{ px: number; size: number; venue: string | null; provIdx: number }>;
          depthRequested: number; depthAvailable: number; reason: 'DEPTH_UNAVAILABLE_SOURCE' | null };
  session: { state: SessionState; calendarId: string; tz: string; openLocal: string; closeLocal: string; nextChangeAt: string | null; earlyClose: boolean };
  tape: Array<{ capTs: string; srcTs: string | null; kind: 'trade' | 'quote' | 'summary'; price: number | null; size: number | null; bid: number | null; ask: number | null; tickDir: 'u' | 'd' | 'f' | null; srcSeq: number | null; conditions: string[]; provIdx: number }>;   // newest first, ≤ tapeRows
  compositionRules: string[];                                     // the BUS-05 rules applied, from core/quote/merge.ts#describeRules()
  dq: Array<'CROSS_SOURCE_DIVERGENCE' | 'STALE_SOURCE' | 'MISSING_CLOSE' | 'PROVIDER_DOWN'>;
};
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `md_lines` (as-of), `quote_ticks` (tape; `quote_ticks_instrument_idx`, one daily partition), `quote_snapshots` (plant warm state), `calendars` + `calendar_sessions` + `calendar_holidays`, `exchanges`, `option_terms` (option header), `rate_terms` |
| Data services | `data.reference.instrument`, `data.ticks.last`, `plant.subjectFor`, `plant.snapshot` (`q:` and `l:`), `plant.ensureHot` |
| Read-through | `('cboe.quote', cboeSymbol, { maxAgeMs: 10_000 })` when the composite is blank or `stale` and the session is open (equity/etf/index/option: `('cboe.options', underlyingSymbol, 60_000)`); `('yahoo.fx', symbol, 60_000)` fx; `('coingecko.simple', id, 60_000)` crypto; `('nyfed.rates', code, 3600e3)` rate |
| Engines | None. (`CHG_NET_1D`, `CHG_PCT_1D`, `TICK_DIR` are plant-derived by `core/quote/derive.ts`, never recomputed here.) |
| Subjects (live) | `q:<instrumentId>` and one `l:<mdLineId>` per line |
| Field ids | equity/etf/index/fx/crypto: `[PX_LAST, LAST_SIZE, LAST_TRADE_TIME, PX_BID, PX_ASK, BID_SIZE, ASK_SIZE, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, PX_OFFICIAL_CLOSE, PX_VOLUME, VWAP, CHG_NET_1D, CHG_PCT_1D, TICK_DIR, IVOL_30D, SESSION_STATE]`; option adds `[OPT_IV, OPT_DELTA, OPT_GAMMA, OPT_VEGA, OPT_THETA, OPT_RHO, OPT_OI, OPT_THEO, OPT_UNDL_PX]`; rate: `[RATE, RATE_P1, RATE_P25, RATE_P75, RATE_P99, RATE_VOLUME_BN, TARGET_FROM, TARGET_TO, SESSION_STATE]` |

#### Resolver
1. `detail` prologue; `lines = detail.mdLines` (as-of, `line_kind ≠ 'reference'`), `subject = plant.subjectFor(id)`, `plant.ensureHot([subject])`.
2. `state = plant.snapshot(subject)`; when `state` is `undefined` or `valueState(state, now) !== 'live'` and `session === 'open'` and `usage !== 'export'`: one `providers.ensure(...)` for the primary line's source (table above), then `snapshot` again. The ensure is skipped when the circuit is open with stored data (the read-through returns `{ fresh:false }`); the cells then carry `st:'stale'`.
3. `composite[f] = cellFromState(ctx, state, f, subject)` for every field in `fieldIds(assetClass)`; fields the plant marks `na` for the class (bid/ask on a Yahoo-only index, `PX_VOLUME` on fx) keep `st:'na'`. `compositeTs`, `compositeSeq`, `tier`, `delayMin`, `dq` from `state`.
4. Per line: `lstate = plant.snapshot('l:<mdLineId>')` (the plant exposes `LineState` as a `QuoteState` projection with `tier` and `state` of that line); `cells` as step 3 with `live: { subject:'l:<mdLineId>', field }`; `ts`, `srcSeq`, `provIdx = ctx.prov.add({ sourceId, provenanceId: lstate.prov.provenanceId, capturedAt, sourceTs, st, tier })`. Lines never polled → `cells` pending, `st:'blank'`.
5. `book`: `depthAvailable = 1` when the composite has both `PX_BID` and `PX_ASK` from a `venue`/`composite` line (Cboe), else `0`; `bids = [{ px: PX_BID, size: BID_SIZE, venue: 'BATS' /* exchanges.mic of the Cboe line's listing or null for the composite line */ }]`, `asks` likewise; `reason = params.depth > depthAvailable ? 'DEPTH_UNAVAILABLE_SOURCE' : null` and `unavailable.add({ field:'book', reason:'NO_SOURCE', detail:'DEPTH_UNAVAILABLE_SOURCE: Cboe delayed quotes publish top of book only' })` when `depth > 1`.
6. `session`: `sessionState(calendar, now)` from `core/quote/session.ts`, plus the template times (`calendar_sessions`) and `earlyClose` from `calendar_holidays`; `nextChangeAt` = next boundary.
7. `tape = await data.ticks.last(id, params.tapeRows)` (`quote_ticks` newest first; `conditions` as stored — `['delayed','synthetic_from_poll']` from v1 sources, FEED-07 placeholder made visible).
8. `compositionRules = describeRules(assetClass)` (the seven BUS-05 rules of ARCHITECTURE §6.2 as short strings, e.g. `'PX_LAST: freshest source ts; ties → lowest priority'`). Return. Budget: 1 DB round-trip (`detail`) + 1 (`quote_ticks`, ≤ 200 rows on one partition) + plant reads; < 100 ms p95 hot; the `/ticks` budget of 2 s never applies (bounded rows).

#### Live
`{ subjects: ['q:<id>', ...lines.map(l => l.subject)], fields: <fieldIds(assetClass)>, conflationMs: 100, essential: ['q:<id>'] }` — the fastest conflation any Tier 1 screen requests (BUS-03; the session takes the minimum across visible screens, FUNCTIONS.md §10 Q6). `composite[*]` cells follow `q:`, `lines[i].cells[*]` follow `l:`; the header's `PX_LAST` flashes on change; the tape receives no push in v1 (a tick row is written per poll change; the screen re-runs the tape with `launchKind:'refresh'` every 30 s while `session.state === 'open'` — shell timer in `screens/Q/Screen.tsx`, one `fn.param` row per refresh is **not** emitted: `launchKind:'refresh'` maps to no usage row, API.md §5.3).

#### Screen
Title `Q · <display> · <name>`; subtitle `<session.state> · <tier> · <delayMin> min delayed · seq <compositeSeq>`; `initialFocus:'book'`. Body `split col [0.18 | 0.82]`: `kv#header` (large: `PX_LAST` with `TICK_DIR` arrow and flash, `CHG_NET_1D`, `CHG_PCT_1D`, `LAST_SIZE`, `LAST_TRADE_TIME` in the calendar tz, state glyph, `dq` badges) over `split row [0.3 | 0.35 | 0.35]`:
```
┌ Q · AAPL US Equity · Apple Inc                                  open · delayed · 15 min · seq 4182 ┐
│ 330.27 ▾  −2.81  −0.84%   size 100   14:26:26 ET   ● live   [Cboe delayed quotes]                     │
│ table#book              │ kv#ohlc                     │ grid#lines (live per l:)                          │
│  bid 330.25 × 40  BATS  │  Open 330.24  High 331.59   │ line | source | symbol | last | bid | ask | vol | src ts | cap ts | pub ts | seq | state │
│  ask 330.28 × 120 BATS  │  Low 328.35   Prev 333.08   │ 101 cboe.quotes AAPL 330.27 330.25 330.28 16.59M 18:26:26 18:41:28 18:41:28 15972883317 live │
│  depth 2..5 —  DEPTH_   │  Off.close —  Vol 16,591,786│ 102 yahoo.chart AAPL 330.18 na na 17.50M 18:41:43 18:41:45 18:41:45 — live        │
│  UNAVAILABLE_SOURCE     │  VWAP —  IV30 24.43%        │ text#rules  composition rules (BUS-05)             │
│ list#tape (newest first): 18:41:28 T 330.27 ×100 u · 18:41:18 Q 330.25/330.28 · …  [delayed · synthetic_from_poll]                      │
│ kv#session  XNAS 09:30–16:00 ET · next change 20:00 ET · early close: no                                                                 │
└ footer sources: Cboe delayed quotes (exchange-published, 15-min delayed); Yahoo Finance chart v8 (unofficial; 15-min delayed)          ┘
```
`view` selects which region has the initial focus and is enlarged (`composite`, `lines`, `tape`). Option variant adds `kv#greeks` (`OPT_IV … OPT_THEO`, `OPT_OI`, `OPT_UNDL_PX`); rate variant replaces book/tape with `kv#fixing` (`RATE`, percentiles, volume, target range) and `grid#lines` shows the NY Fed line only. Skeleton: header with `—`, empty book, lines rows from `detail.mdLines` with pending cells. Entitlement: `eod` users see `PX_OFFICIAL_CLOSE, PX_CLOSE_1D, PX_VOLUME, PX_OPEN/HIGH/LOW` and every other cell `—` `TIER_EOD` (API.md §6.6); `book.reason` renders as the muted text under the book; `dq` badges (`CROSS_SOURCE_DIVERGENCE`) are amber with the two prices in the tooltip (OPS-03).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid (`grid#lines`) | `line-provenance` | `ctx.provenance(row.provIdx)` — source, captured-at, request key → raw fixture (DATA-10) |
| `Enter` | grid (`list#tape`) | `tick-provenance` | `ctx.provenance(item.provIdx)` |
| `+` / `-` | always | `depth-up` / `depth-down` | `setParams({ depth: ±1 })` (1–10) |
| `T` | always | `more-tape` | `setParams({ tapeRows: min(200, tapeRows + 30) })` |
| `V` | always | `cycle-view` | `setParams({ view: next })` |
| `G` | always | `open-gip` | `ctx.navigate('GIP')` |
| `P` | always | `open-gp` | `ctx.navigate('GP')` |
| `D` | always | `open-des` | `ctx.navigate('DES')` |
| `M` | always | `open-qm` | `ctx.navigate('QM KEYS=' + display)` (keys-mode monitor seeded with this security) |
| `O` | always | `open-omon` | `ctx.navigate('OMON')` (equity/etf/index; option → underlying) |
| `Ctrl+E` | always | reserved | `/data/csv` `kind:'tick'` for the last session (tape export) |

#### CSV
`filename = 'Q_' + displaySlug + '_' + asOfCompact + '.csv'`. Columns are payload-dependent: `section,key,composite,<one column per lines[i].sourceId>,srcTs,capTs,pubTs,state` — `section:'composite'` rows: one per field of `fieldIds(assetClass)` (`key` = field id, `composite` = `composite[key].v`, each source column = that line's `cells[key].v`, `srcTs/capTs/pubTs` = the composite's `fieldTs`-based src and the composite `ts`, `state` = `composite[key].st`); `section:'book'` rows: `key` = `bid1`/`ask1`, `composite` = px, first source column = size; `section:'session'` rows: `state`, `calendarId`, `openLocal`, `closeLocal`. The tape is **not** in PRINT (it is the `Ctrl+E` tick export, `/data/csv kind:'tick'`). Example: `composite,PX_LAST,330.27,330.27,330.18,2026-09-15T18:26:26Z,2026-09-15T18:41:28.412Z,2026-09-15T18:41:28.413Z,live`. The `# asOf` header line and `# regenerated` flag tell the reader whether the values are the screen's moment (FUNCTIONS.md §10 Q4).

#### Help
summary `Live composite quote with per-source lines, three timestamps, top of book and tape`; description `Q shows the composite quote the ticker plant maintains for the loaded security and how it was composed: each market-data line (Cboe delayed quotes, Yahoo chart) with its own values, provider sequence number and the three timestamps of every update — source-published, captured and published to you. The book is top of book only, because no v1 source publishes depth; requested levels beyond it are shown blank with the reason. The tape lists the observed changes captured from the delayed feeds (one row per poll that changed, marked synthetic_from_poll). Colour and the dot glyph show staleness: a number that stops updating is marked stale within three poll intervals. Options show the Cboe-published greeks; rates show the fixing with percentiles and volume.`; params `depth` ("book levels requested (source publishes 1)", `10`), `tapeRows` ("tape rows 10–200", `TAPE=100`), `view` ("composite, lines or tape emphasis", `VIEW=LINES`); sources `['cboe.quotes','cboe.options','yahoo.chart','coingecko.simple','nyfed.rates','internal.derived']`; related `['QM','GIP','GP','DES','OMON']`.

#### Unavailable and reason codes
`{ field:'book', reason:'NO_SOURCE', detail:'DEPTH_UNAVAILABLE_SOURCE: Cboe delayed quotes publish top of book only' }` (`depth > 1`; footer code `DEPTH_UNAVAILABLE_SOURCE`); `{ field:'book', reason:'NOT_APPLICABLE', detail:'no book for this instrument' }` (fx, crypto, rate, Yahoo-only index); `{ field:'tape', reason:'NO_SOURCE', detail:'no ticks captured in the last 30 days' }`; `{ field:'composite.VWAP', reason:'NO_SOURCE', detail:'no source publishes intraday VWAP' }` (always in v1 — `VWAP` on `q:` is `na`); entitlement `TIER_EOD` / `NO_FIRM_ENTITLEMENT` per cell via `meta.entitlement`; `PROVIDER_DOWN` → `dq` badge and `stale` cells with the last values (never blank, never silently live — ENTL-05/TERM-12); `SOURCE_TIER_CAP` in `meta.entitlement` when a `realtime` tier was requested (subtitle shows `delayed`).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/Q.golden.test.ts` | `AAPL US Equity Q` from `cboe-quote-AAPL.json` + `yahoo-chart-AAPL-1d-1m.json` lines: `composite.PX_LAST.v === 330.27`, `lines[0].srcSeq === 15972883317`, `compositeTs.src === '2026-09-15T18:26:26.000Z'` (ET → UTC rule), `book.depthAvailable === 1`, `book.reason === 'DEPTH_UNAVAILABLE_SOURCE'` for `depth 5`; `SOFR Index Q` has `composite.RATE.v === 3.62`; `SPX Index Q` `PX_BID.st === 'live'` (Cboe publishes an index bid) and `PX_VOLUME.st === 'na'` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `Q.quote.csv` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | `composite[*].v` equals the WS `snap.f` for `q:42` at the frozen clock (API-05) |
| composition | `packages/server/test/unit/plant/merge.test.ts` | the seven BUS-05 rules with two lines; divergence > 0.5 % sets `dq` and writes `dq_events` |
| screen | `packages/web/test/screens/Q.test.tsx` | header cell flashes on a `q:` delta; line cells registered on `l:`; `+`/`-` call `setParams`; `Enter` on a line calls `ctx.provenance`; entitlement blanks render `—` with tooltip; skeleton |
| e2e | `packages/e2e/tests/quote.spec.ts` | `AAPL US Equity Q <GO>` paints `330.27`; replayed deltas flash the last cell; stopping the replay feed turns the header glyph stale within 30 s (TERM-12); `eod@demo` sees blanks with `TIER_EOD` (ENTL-05) |

---

### QM — Quote Monitor

| Attribute | Value |
| --- | --- |
| Code / aliases | `QM` / `MON` |
| Tier / category | 1 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/QM.ts` · `packages/server/src/functions/QM/resolve.ts` · `packages/web/src/screens/QM/Screen.tsx` · `fixtures/golden/functions/QM.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (BUS-02) (BUS-03) (BUS-04) (BUS-08) (TERM-06) (TERM-08) (TERM-11) (TERM-12) (REF-07) (DATA-10) (ENTL-05) (NFR-02) |

#### Params
```ts
export const QmSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('watchlist'), id: z.number().int().optional(), name: z.string().max(80).optional() }),   // neither → 'default' (§Resolver step 1)
  z.object({ kind: z.literal('index'), id: z.number().int().optional(), code: z.string().max(12).optional() }),
  z.object({ kind: z.literal('keys'), refs: z.array(SecurityRefInput).min(1).max(500) }),
]);
export const QmParams = z.object({
  source: QmSource.default({ kind: 'watchlist' }),
  columns: z.array(FieldId).min(1).max(30).default(['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D', 'PX_BID', 'PX_ASK', 'BID_SIZE', 'ASK_SIZE', 'PX_VOLUME', 'PX_HIGH', 'PX_LOW', 'LAST_TRADE_TIME', 'SESSION_STATE']),
  sort: SortSpec.optional(),
  groupBy: z.enum(['none', 'GICS_SECTOR', 'EXCH_CODE', 'ASSET_CLASS', 'MARKET_SECTOR']).default('none'),
});
```
#### Argument grammar
`positional [{ name:'source', type:'watchlist', optional:true }]` (the `watchlist` ArgType yields `{ kind:'watchlist', id }` or `{ kind:'watchlist', name }`, FUNCTIONS.md §2.4/§2.7), `keyed { IDX: { name:'source', type:'index' } /* → { kind:'index', id } */, KEYS: { name:'source', type:'string' } /* 'AAPL US Equity,MSFT US Equity' → { kind:'keys', refs:[{ref},…] } */, COLS: { name:'columns', type:'string' } /* comma-separated field ids */, SORT: { name:'sort', type:'string' } /* 'CHG_PCT_1D:desc' */, GROUP: { name:'groupBy', type:'enum', values:['none','GICS_SECTOR','EXCH_CODE','ASSET_CLASS','MARKET_SECTOR'] } }`, no `rest`.
Examples: `QM` → `{ source:{ kind:'watchlist' }, columns:[defaults], groupBy:'none' }` · `QM MAG7` → `{ source:{ kind:'watchlist', name:'MAG7' } }` · `QM IDX=SPX GROUP=GICS_SECTOR SORT=CHG_PCT_1D:desc` → `{ source:{ kind:'index', id:<SPX> }, groupBy:'GICS_SECTOR', sort:{ col:'CHG_PCT_1D', dir:'desc' } }`.

#### Payload
```ts
export type QmPayload = {
  variant: 'default';
  source: { kind: 'watchlist' | 'index' | 'keys'; id: number | null; name: string; asOfDate: string | null /* index membership date */; sourceId: string | null /* 'sec.archives' | 'ssga.holdings' */ };
  title: string;                                                   // 'MAG7' | 'SPX Index members (2026-09-14, SSGA)' | 'Keys (3)'
  columns: MonitorColumn[];                                        // §0.2, in params.columns order, label/fmt/decimals from the dictionary
  rows: MonitorRow[];                                              // §0.2; cells keyed by column id; group key in gicsSector/exchCode/assetClass/marketSector
  skipped: Array<{ ref: string; reason: 'SECURITY_NOT_FOUND' | 'AMBIGUOUS_SECURITY' | 'NOT_IN_UNIVERSE' | 'FORMULA_ROW' }>;   // keys/watchlist entries that produced no row
  groupBy: QmParams['groupBy']; sort: SortSpec | null;
  counts: { rows: number; live: number; pending: number; stale: number; blank: number };
  asOf: string;                                                    // clock.now() at resolve
};
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `watchlists` + `watchlist_items` (RLS: own + shared), `indices` + `index_members` (current, `index_members_current_idx`), `instruments` (current), `entity_classifications` (GICS sector), `quote_snapshots` (through the plant) |
| Data services | `data.workspace.watchlist`, `data.reference.members`, `data.reference.resolve` (keys), `data.snapshot.fields` (plant + reference merge, entitlement-filtered), `plant.ensureHot` |
| Read-through | None (§0.4 rule 2). |
| Engines | None. |
| Subjects (live) | `q:<instrumentId>` per row (≤ 500 rows in keys mode, ≤ 2 000 watchlist items, 503 index members) |
| Field ids | `default` (`fieldIds(null)`): the requested `params.columns` — evaluated per row's asset class by the runner using `'*'` (the manifest returns `params`-independent `[PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_BID, PX_ASK, BID_SIZE, ASK_SIZE, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, PX_VOLUME, LAST_TRADE_TIME, SESSION_STATE, IVOL_30D, VWAP, NAME, TICKER, EXCH_CODE, GICS_SECTOR_NAME, CUR_MKT_CAP]` as the pre-check superset; a column outside the dictionary → `400 VALIDATION_FAILED` `fnParams`) |

#### Resolver
1. **Source → instrument ids.** `watchlist`: `id` → `data.workspace.watchlist(id)`; `name` → the caller's visible watchlist with that name (case-insensitive); neither → `'default'` = the caller's own watchlist with the greatest `updated_at`; none at all → `rows: []`, `unavailable.add({ field:'source', reason:'NOT_APPLICABLE', detail:'no watchlists — press W to create one' })`. A `name` that matches no watchlist but matches `indices.code` → treated as `{ kind:'index' }` (so `QM SPX` works without `IDX=`) and `payload.source.kind = 'index'`; matching neither → `404 NOT_FOUND` (`message: 'watchlist or index <name> not found'`). Formula rows of a watchlist are skipped (`skipped[].reason:'FORMULA_ROW'` — W shows them). `index`: `data.reference.members(indexId, asOfDate = today)` → member instrument ids, `asOfDate`, `sourceId`. `keys`: `data.reference.resolve` per ref (batched, `POST /ref/resolve` semantics); unresolved → `skipped[]`.
2. `columns = params.columns.map(monitorColumn)`; one query over current `instruments` joined to `entity_classifications` (GICS sector) and `exchanges` for the ids (`instruments_current_idx`).
3. `subjects = ids.map(plant.subjectFor)`; `plant.ensureHot(subjects)`; `snap = await data.snapshot.fields(ids, columns.map(c => c.fieldId))` — one `plant.snapshotMany` plus reference fields (`NAME`, `TICKER`, `EXCH_CODE`, `GICS_SECTOR_NAME`, `CUR_MKT_CAP` from the reference merge) already entitlement-filtered per row/field (`null` + `r`). Rows without state → pending cells (§0.4 rule 1).
4. `rows` in source order (watchlist `position`, index weight desc, keys as given); `sort` is applied by the screen (the payload keeps source order so a re-sort is client-only and free); `counts` from the cells' `st`.
5. Return. Budget: 2 DB round-trips + one `snapshotMany` (≤ 600 subjects); < 120 ms p95 for MAG7, < 250 ms for SPX members.

#### Live
`{ subjects: rows.map(r => r.subject), fields: columns.filter(c => c.fieldId && isPlantField(c.fieldId)).map(c => c.fieldId), conflationMs: 250 }` (reference columns such as `NAME` are static). `grid.live.subjectOf = row => row.subject`. The grid marks off-viewport rows `essential:false` (`essential` message) so the server may shed them under backpressure and re-subscribes on scroll (BUS-04, ARCHITECTURE §6.6); `PX_LAST`, `CHG_NET_1D`, `CHG_PCT_1D` are never shed by the plant (NFR-02).

#### Screen
Title `QM · <title>`; subtitle `<rows> rows · live <live> · pending <pending> · stale <stale> · conflation <ms> ms`; `initialFocus:'rows'`. Body: `grid#rows` fills the panel — `columns = [{ id:'key', label:'Security', frozen }, { id:'name', label:'Name' }, ...columns]` (`frozenColumns: 2`), `rows[i].cells` with `live` cells registered in `web/grid/cellRegistry` (per-cell flash-up/down on change, ≤ 8 ms per frame for 2 000 visible cells — TERM-08), `groupBy` renders group header rows with the group's row count and, for `PX_LAST`-bearing groups, no aggregates (a monitor shows values, not sums); `sort` from params or the last `S` press (client-side, stable, `null`/pending last); `selectable: true`; `emptyText: 'No rows — Insert adds a security'` (keys mode) or the `unavailable` detail. Skeleton: the grid header from `params.columns` and the row keys from the frame's previous payload when any (stale-while-revalidate), else 8 muted rows. Entitlement: denied cells `—` with reason tooltip; a whole column denied for every row collapses to a muted header with the reason. `meta.staleness:'stale'` adds the amber footer strip `feed stale since <ts>` (TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid | `open-des` | `ctx.navigate(row.key + ' DES')` |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `Q` | grid | `open-q` | `ctx.navigate(row.key + ' Q')` |
| `P` | grid | `open-gp` | `ctx.navigate(row.key + ' GP')` |
| `S` | grid | `sort-column` | sorts by the focused column (toggles asc/desc on repeat); `setParams({ sort })` so the sort persists in the frame (one `fn.param`) |
| `Shift+S` | grid | `clear-sort` | `setParams({ sort: undefined })` |
| `G` | always | `cycle-group` | `setParams({ groupBy: next })` |
| `C` | always | `add-column` | `ctx.prompt('field')` → `setParams({ columns: [...columns, id] })` (max 30) |
| `Shift+C` | grid | `remove-column` | removes the focused column (min 1) |
| `Insert` | grid | `add-row` | keys mode: `ctx.prompt('security')` → `setParams({ source: { kind:'keys', refs: [...refs, ref] } })`; watchlist mode: adds to the watchlist via `sdk.watchlists.setItems` then `setParams({})` |
| `Delete` | grid | `remove-row` | keys mode: removes the focused ref; watchlist mode (owner only): removes the item |
| `W` | always | `save-as-watchlist` | `ctx.prompt('text', { label:'Watchlist name' })` → `sdk.watchlists.create({ name, columns: params.columns.map(id => ({ id })), items: rows.map(r => ({ security:{ id:r.instrumentId } })) })` then `ctx.navigate('W ' + name)` |
| `L` | always | `open-w` | `ctx.navigate('W' + (source.kind === 'watchlist' ? ' ' + source.name : ''))` |
| `Ctrl+E` | grid | reserved | `/data/csv` `kind:'realtime'` for the visible rows and columns |

#### CSV
`filename = 'QM_' + titleSlug + '_' + asOfCompact + '.csv'`. Columns are payload-dependent: `key,name,assetClass,exchCode,gicsSector,` + `columns[].id` + `,state`. One row per `rows[]` in the payload's (source) order — the sort is a screen concern; values are `cells[col].v` from the cached result (`# asOf` line = resolve time; a PRINT after the 10-minute cache re-resolves and marks `regenerated: true`). Example: `AAPL US Equity,Apple Inc,equity,US,Information Technology,330.27,-2.81,-0.8436,330.25,330.28,40,120,16591786,331.59,328.35,2026-09-15T18:26:26Z,open,live`.

#### Help
summary `Live quote grid over a watchlist, index members or a typed list of securities`; description `QM is a monitor: every row is one security and every cell updates from the ticker plant with a flash on change. The source is a watchlist (default: your most recently updated one), an index's current constituents (IDX=SPX from the SPY N-PORT/SSGA membership) or a list of keys. Columns are dictionary fields; sort and group are client-side and remembered in the frame. Rows off screen are marked non-essential so a slow connection widens conflation or sheds them before anything is lost; a stale feed is shown, never silently frozen. Enter opens DES, Q the quote, W saves the rows as a watchlist.`; params `source` ("watchlist name/id, IDX=<index> or KEYS=a,b,c", `MAG7`), `columns` ("field ids", `COLS=PX_LAST,CHG_PCT_1D,PX_VOLUME`), `sort` ("column:dir", `SORT=CHG_PCT_1D:desc`), `groupBy` ("none, GICS_SECTOR, EXCH_CODE, ASSET_CLASS, MARKET_SECTOR", `GROUP=GICS_SECTOR`); sources `['cboe.quotes','yahoo.chart','coingecko.simple','nyfed.rates','sec.archives','ssga.holdings','wiki.sp500','internal.derived']`; related `['W','Q','DES','MEMB','WEI']`.

#### Unavailable and reason codes
`{ field:'source', reason:'NOT_APPLICABLE', detail:'no watchlists — press W to create one' }`; `skipped[]` reasons `SECURITY_NOT_FOUND | AMBIGUOUS_SECURITY | NOT_IN_UNIVERSE | FORMULA_ROW` rendered as a muted footer line `3 entries skipped (Enter for detail)`; `{ field:'source', reason:'NO_SOURCE', detail:'index <code> has no membership source' }` for `IDX=` on a non-SPX index; per-cell `TIER_EOD` / `NO_FIRM_ENTITLEMENT`; pending cells (`…`) until the first `snap`; WS `status 'shed'` rows show a grey `shed` glyph until re-subscribed (BUS-04, never silent).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/QM.golden.test.ts` | `QM MAG7` at the frozen clock equals `QM.default.json`: 7 rows, AAPL cells live from the fixture, the six others pending (`st:'blank'`, no `r`, `provIdx:-1`), `counts.pending === 6`; `QM IDX=SPX` has 503 rows with `source.asOfDate === '2026-09-14'` and `sourceId === 'ssga.holdings'`; `QM SPX` resolves to the same index source |
| csv parity | `packages/core/test/functions/csv.test.ts` | `QM.default.csv` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | AAPL row cells equal the WS snapshot for `q:42` |
| entitlement | `packages/server/test/integration/functions/QM.entitlement.test.ts` | `eod@demo`: every `PX_LAST` cell `null` with `TIER_EOD`, `PX_VOLUME` populated |
| grid | `packages/web/test/screens/QM.test.tsx`, `packages/web/test/grid.frame-budget.test.ts` | 2 000 visible cells × 5 000 changes/s under 8 ms p95 rAF; `S` sorts and calls `setParams`; group headers; off-viewport rows send `essential:false`; skeleton from the previous payload |
| e2e | `packages/e2e/tests/live-grid.spec.ts` | `QM MAG7 <GO>` flashes AAPL cells on the replayed session; stopping the feed shows the stale strip within 30 s (TERM-08/12); `Enter` opens DES; `W` saves a new watchlist visible in `W` |

---

### W — Watchlists

| Attribute | Value |
| --- | --- |
| Code / aliases | `W` / `WL`, `WATCH` |
| Tier / category | 1 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/W.ts` · `packages/server/src/functions/W/resolve.ts` · `packages/web/src/screens/W/Screen.tsx` · `fixtures/golden/functions/W.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (CHRT-07) (TERM-05) (TERM-06) (TERM-08) (TERM-12) (SEC-05) (DATA-10) (ENTL-05) (BUS-02) |

#### Params
```ts
export const WParams = z.object({
  watchlist: z.union([z.object({ id: z.number().int() }), z.object({ name: z.string().max(80) })]).optional(),   // undefined → the caller's most recently updated own list
  view: z.enum(['grid', 'manage', 'share']).default('grid'),
});
```
#### Argument grammar
`positional [{ name:'watchlist', type:'watchlist', optional:true }]` (yields `{ id }` or `{ name }` — the `kind` wrapper of QM is not used here), `keyed { VIEW: { name:'view', type:'enum', values:['grid','manage','share'] } }`, no `rest`.
Examples: `W` → `{ view:'grid' }` · `W MAG7` → `{ watchlist:{ name:'MAG7' }, view:'grid' }` · `W 12 VIEW=SHARE` → `{ watchlist:{ id:12 }, view:'share' }`. (`W US Equity` is Wayfair — the sector anchor wins, FUNCTIONS.md §2.7.)

#### Payload
```ts
export type WPayload = {
  variant: 'default';
  me: { userId: number; firmId: number };
  watchlists: Array<{ watchlistId: number; name: string; ownerUserId: number; ownerDisplay: string; isOwner: boolean; sharedScope: 'private' | 'firm' | 'users'; itemCount: number; updatedAt: string }>;
  active: {
    watchlistId: number; name: string; isOwner: boolean; sharedScope: 'private' | 'firm' | 'users'; sharedUserIds: number[]; updatedAt: string;
    columns: MonitorColumn[];                                      // field columns (fieldId set) and formula columns (id 'c<n>', formula set)
    sort: SortSpec[]; groupBy: string | null;
    rows: Array<MonitorRow & {                                      // MonitorRow.cells holds the field columns AND the formula columns (server-evaluated once)
      position: number; label: string | null; note: string | null; addedAt: string;
      formula: string | null;                                       // basket/formula row: instrumentId is 0 and subject is '' (CHRT-07)
      deps: string[];                                               // subjects a formula row/column depends on ('q:42','q:7'); empty for plain rows
    }>;
    formulaErrors: Array<{ where: string /* 'c1' | 'row:3' */; message: string }>;
  } | null;
};
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `watchlists`, `watchlist_items` (RLS `watchlists_scope`, `watchlist_items_scope`), `users` (owner display), `instruments`, `entity_classifications`, `quote_snapshots` (plant), `xbrl_facts`/`fin_statements` only through `data.snapshot.fields` reference merge for fundamental field columns (`CUR_MKT_CAP`, `PE_RATIO`) |
| Data services | `data.workspace.watchlists`, `data.workspace.watchlist`, `data.snapshot.fields`, `data.reference.resolve` (formula leaves), `plant.ensureHot` |
| Read-through | None (§0.4 rule 2). |
| Engines | `formula@1.0.0` (`core/formula`: lexer → parser → evaluator over row field values for `c<n>` columns, and over instrument snapshots for formula rows; functions `RATIO`, `SPREAD`, `NORM`, `MA`, arithmetic, field refs) |
| Subjects (live) | `q:<instrumentId>` per plain row, plus every `deps[]` subject of formula rows/columns |
| Field ids | `default`: the union of the active list's field columns (pre-check superset `[PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_BID, PX_ASK, PX_VOLUME, PX_OPEN, PX_HIGH, PX_LOW, PX_CLOSE_1D, LAST_TRADE_TIME, SESSION_STATE, IVOL_30D, NAME, TICKER, EXCH_CODE, GICS_SECTOR_NAME, CUR_MKT_CAP, EQY_SH_OUT, PE_RATIO, DVD_YIELD, PX_HIGH_52W, PX_LOW_52W, RET_YTD, RET_1Y, VOL_30D, BETA_1Y]`; a column outside the dictionary → `400 VALIDATION_FAILED`) |

#### Resolver
1. `watchlists = await data.workspace.watchlists()` (RLS: own + firm-shared + shared-with-me; `itemCount` by a lateral count). Select `active`: `params.watchlist.id` → that list (RLS miss → `404 NOT_FOUND`); `.name` → case-insensitive match over the visible lists (`404 NOT_FOUND 'watchlist <name> not found'` when none); undefined → own list with the greatest `updated_at`; no lists → `active: null`, `unavailable.add({ field:'active', reason:'NOT_APPLICABLE', detail:'no watchlists — Ctrl+N creates one' })`.
2. `list = await data.workspace.watchlist(active.watchlistId)` (columns, sort, groupBy, items in `position` order). `columns` = field columns via `monitorColumn(id)` and formula columns as `{ id:'c<n>', label, formula, fmt:'px' | from a `decimals` hint }`.
3. Plain rows: `ids` → `data.snapshot.fields(ids, fieldColumnIds)` (entitlement-filtered; pending when unpolled), `MonitorRow` per item. Formula rows: `core/formula.parse(formula)` → leaf refs → `data.reference.resolve` → `plant.snapshotMany` on their subjects → `evaluate(ast, snapshots)` → the row's `PX_LAST`/`CHG_PCT_1D` cells are the formula's value and its day change (when every leaf has `PX_CLOSE_1D`), `deps = leaf subjects`, `provIdx` = the first leaf's `addQuote`; parse/evaluation errors → `formulaErrors[]` and the row's cells `{ v:null, st:'na' }`.
4. Formula columns: for every row, `evaluate(colAst, row.cells)` (field refs resolve to that row's cell values; missing/denied inputs → `{ v:null, st:'na' }`); errors → `formulaErrors[]` once per column. Engine `formula@1.0.0` with `inputsHash` over the column formulas.
5. Return. Budget: 3 DB round-trips (lists, items + instruments, resolve leaves) + `snapshotMany`; < 150 ms p95 for a 50-row list.

#### Live
`{ subjects: unique([...rows.filter(r => r.subject).map(r => r.subject), ...rows.flatMap(r => r.deps)]), fields: unique(fieldColumnIds ∪ formulaInputFieldIds), conflationMs: 250 }`. The grid registers plain-row field cells as live; formula cells (`c<n>` columns and formula rows) are recomputed client-side by `core/formula` on every delta of their inputs (`web/screens/W/formulaCells.ts` subscribes to the `UpdateEvent` of `deps` and rewrites the cell through `cellRegistry`, the same evaluator as the server so CSV = screen at resolve time — CHRT-07).

#### Screen
Title `W · <active.name>` (or `W · Watchlists`); subtitle `<n> rows · <scope> · owner <ownerDisplay> · updated <updatedAt>`; `initialFocus: active ? 'rows' : 'lists'`. Body `split row [0.22 | 0.78]`: `list#lists` (one item per watchlist: name · count · scope badge · `shared` glyph; the active one highlighted) — `grid#rows` (`frozenColumns: 2` key + name; columns = `active.columns`; formula columns italic with the formula as tooltip; formula rows show the formula as the key and a `ƒ` badge; `groupBy`/`sort` from the list definition; `selectable: true`; `emptyText: 'Empty list — Insert adds a security'`). `view:'manage'` swaps the grid for `form#manage` (name, columns editor as repeated `field`/`text` inputs, sort, groupBy); `view:'share'` shows `form#share` (`sharedScope` enum, `sharedUserIds` via `ctx.prompt('text')` directory lookup — users of the same firm only, SEC-05). Skeleton: lists panel from the previous payload, grid header, muted rows. `formulaErrors` render as an amber `badges#errors` row (`c1: unknown field FOO`). Entitlement per cell as QM; a shared list you do not own shows a lock glyph and disables mutations (`isOwner:false`).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid (`list#lists`) | `open-list` | `setParams({ watchlist:{ id }, view:'grid' })` |
| `Enter` | grid (`grid#rows`) | `open-des` | `ctx.navigate(row.key + ' DES')` (formula rows: `ctx.navigate('<' + formula + '> GP')`) |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `G` | grid | `open-gp` | `ctx.navigate(row.key + ' GP')` |
| `M` | always | `open-qm` | `ctx.navigate('QM ' + active.name)` |
| `Insert` | grid | `add-row` | owner: `ctx.prompt('security')` → `sdk.watchlists.setItems(id, items + [{ security }])` → `setParams({})` (refresh; one `fn.param`) |
| `Shift+Insert` | grid | `add-formula-row` | owner: `ctx.prompt('text', { label:'Formula, e.g. RATIO(AAPL US Equity, SPX Index)' })` → `setItems(items + [{ formula, label }])` |
| `Delete` | grid | `remove-row` | owner: removes the focused item (`setItems`) |
| `Alt+ArrowUp` / `Alt+ArrowDown` | grid | `move-up` / `move-down` | owner: reorders (`position` swap, `setItems`) |
| `F` | always | `add-formula-column` | owner: `ctx.prompt('text', { label:'Column formula, e.g. PX_LAST/PX_CLOSE_1D-1' })` then `('text', { label:'Label' })` → `sdk.watchlists.update(id, { columns: [...columns, { id:'c<n>', formula, label }] })` |
| `C` | always | `add-field-column` | owner: `ctx.prompt('field')` → `update(id, { columns: [...columns, { id }] })` |
| `Shift+C` | grid | `remove-column` | owner: removes the focused column |
| `S` | grid | `sort-column` | owner persists via `update(id, { sort })`; non-owner sorts client-side only |
| `R` | always | `rename` | owner: `ctx.prompt('text', { initial: name })` → `update(id, { name })` |
| `Ctrl+N` | always | `new-list` | `ctx.prompt('text', { label:'New watchlist name' })` → `sdk.watchlists.create({ name, columns: defaultColumns })` → `setParams({ watchlist:{ id } })` |
| `Ctrl+Shift+S` | always | `share` | `setParams({ view:'share' })` |
| `V` | always | `cycle-view` | `setParams({ view: next })` |
| `X` | always | `delete-list` | owner: `ctx.prompt('text', { label:'Type the list name to delete' })` must equal `name` → `sdk.watchlists.remove(id)` → `setParams({ watchlist: undefined })` |
| `Ctrl+E` | grid | reserved | `/data/csv` `kind:'realtime'` for the plain rows |
Every mutation is a `sdk.watchlists.*` call (the resolver never writes), followed by a re-run; the workspace autosaves the frame (TERM-05) so the last opened list comes back on any machine.

#### CSV
`filename = 'W_' + nameSlug + '_' + asOfCompact + '.csv'`. Columns are payload-dependent: `position,key,name,` + `active.columns[].id` (field and formula columns) `,label,note`. One row per `active.rows[]`; formula rows put the formula in `key` and their evaluated cells; values from the cached payload at resolve time (formula columns evaluated server-side by the same `core/formula`). `GET /watchlists/:id/export.csv` (API.md §5.8) runs this resolver with `params { watchlist:{ id } }` and this `csv` spec — one implementation. Example: `1,AAPL US Equity,Apple Inc,330.27,-0.8436,-0.008436,,`.

#### Help
summary `Your watchlists: live grid, formula columns and rows, sharing, reorder`; description `W lists your watchlists and the ones shared with you (firm-wide or by name) and shows the selected one as a live grid. Columns are dictionary fields or formulas over them (F adds one, e.g. PX_LAST/PX_CLOSE_1D-1); rows are securities or formulas over securities (Shift+Insert, e.g. RATIO(AAPL US Equity, SPX Index)), evaluated in the client on every update with the same formula engine the server uses for export. Lists belong to a person and never leave the firm; sharing is by scope. Edits save immediately; the last list you opened is part of your workspace. QM (M) shows the same list as a plain monitor.`; params `watchlist` ("name or id; default: your most recent list", `MAG7`), `view` ("grid, manage or share", `VIEW=SHARE`); sources `['cboe.quotes','yahoo.chart','coingecko.simple','nyfed.rates','sec.companyfacts','internal.derived']`; related `['QM','DES','GP','SECF']`.

#### Unavailable and reason codes
`{ field:'active', reason:'NOT_APPLICABLE', detail:'no watchlists — Ctrl+N creates one' }`; `formulaErrors[]` (`unknown field <id>`, `unresolved security <ref>`, `parse error at <pos>`) as amber badges — the affected cells are `st:'na'`; per-cell entitlement reasons; pending cells; `403 FORBIDDEN` from the SDK on a mutation of a list you do not own is shown in the footer as `read-only: owned by <ownerDisplay>`; `409 DUPLICATE_NAME` on create/rename → footer `name already used`.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/W.golden.test.ts` | `pm@demo` `W MAG7` at the frozen clock equals `W.default.json` (3 lists visible, 7 rows, formula column `c1 = PX_LAST/PX_CLOSE_1D-1` evaluated to `-0.008436` for AAPL and `na` for pending rows) |
| formula | `packages/core/test/formula/evaluator.test.ts`, `packages/server/test/integration/functions/W.formula.test.ts` | `RATIO(AAPL US Equity, SPX Index)` row = `330.27 / 7585.75`; `deps = ['q:42','q:<SPX>']`; a bad formula lands in `formulaErrors` without failing the run (CHRT-07) |
| tenant isolation | `packages/server/test/integration/functions/W.rls.test.ts` | a user of `Other Desk` cannot see `MAG7` (`404 NOT_FOUND` by id; not listed); a `users`-scoped list is visible only to the listed user ids (SEC-05) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `W.default.csv`; `GET /watchlists/:id/export.csv` byte-equals PRINT for the same result |
| screen | `packages/web/test/screens/W.test.tsx` | formula cells recompute on an `UpdateEvent` of a dep; `Insert`/`Delete`/`Alt+Arrow` call `sdk.watchlists.setItems` then `setParams`; non-owner has mutations disabled; skeleton |
| e2e | `packages/e2e/tests/watchlist.spec.ts` | `W <GO>`, `Ctrl+N` "e2e", `Insert` `AAPL US Equity`, `F` `PX_LAST/PX_CLOSE_1D-1`; reload restores the list and column (TERM-05); `Ctrl+P` CSV equals the grid |

---

<!-- CONTINUE -->
