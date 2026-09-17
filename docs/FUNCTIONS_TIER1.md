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

`core/analytics/stats` exports `Conventions = { returns: 'simple', priceBasis: 'close', adjust: 'price', annualisation: 252, volWindow: 30, betaBenchmark: 'SPX Index', betaWindow: 252 }` and echoes it in every output; `periodReturns` uses the instrument's calendar to find `t₋`. The join is `instruments.primary_listing_id → listings.listing_id`, then `listings.mic → exchanges.mic → exchanges.calendar_id` (there is no `instruments.primary_listing` column and no FK from `instruments` to `exchanges`; CONTRACTS §1.2 declares `instruments.primary_listing_id bigint` and `listings.mic char(4)`), with `'FX_USD'` for fx and `'WEEKEND'` for crypto. An instrument with no primary listing, or a listing whose `mic` has no `exchanges` row or a null `exchanges.calendar_id`, takes the same degradation path as WEI (TIER1.d §WEI): the period return is `null` with `ctx.unavailable.add({ field:'<periodField>', reason:'NO_SOURCE', detail:'no calendar seeded for <mic>' })` and footer code `NO_CALENDAR_FOR_VENUE` — it is never silently computed on raw calendar days; `vol30d` = stdev of 30 daily simple returns × √252 × 100; `beta1y` = OLS slope of the instrument's 252 daily returns on `SPX Index` returns (only when both series cover ≥ 200 sessions, else `null` with `meta.unavailable` `NOT_APPLICABLE 'fewer than 200 overlapping sessions'`). Engine entry: `{ name: 'stats', version: '1.0.0', inputsHash }`.

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
| Data services | `data.historical.bars` (does resampling, adjustment, currency), `data.curves.points`, `data.curves.history(curveId, tenor, from, to, quoteType)` (**addition — see §99 Additions required**, backing `GET /curves/:curveId/history`, API.md §5.4 L549), `data.rates.history`, `data.econ.observations`, `plant.snapshot` |
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
  groupBy: z.enum(['none', 'GICS_SECTOR_NAME', 'EXCH_CODE', 'MARKET_SECTOR_DES']).default('none'),   // column ids (ScreenSpec `Node.grid.groupBy` is a column id), each a real dictionary field id (API.md §7 L1098)
});
```
#### Argument grammar
`positional [{ name:'source', type:'watchlist', optional:true }]` (the `watchlist` ArgType yields `{ kind:'watchlist', id }` or `{ kind:'watchlist', name }`, FUNCTIONS.md §2.4/§2.7), `keyed { IDX: { name:'source', type:'index' } /* → { kind:'index', id } */, KEYS: { name:'source', type:'string' } /* 'AAPL US Equity,MSFT US Equity' → { kind:'keys', refs:[{ref},…] } */, COLS: { name:'columns', type:'string' } /* comma-separated field ids */, SORT: { name:'sort', type:'string' } /* 'CHG_PCT_1D:desc' */, GROUP: { name:'groupBy', type:'enum', values:['none','GICS_SECTOR_NAME','EXCH_CODE','MARKET_SECTOR_DES'] } }`, no `rest`. Every `GROUP=` value is a field id in the API.md §7 dictionary and therefore a `GridColumn.id` the screen can group on; there is no `ASSET_CLASS` dictionary field, so asset class is not a grouping key in v1 (adding one would mean a new reference field sourced from `instruments.asset_class` — an addition this document does not make).
Examples: `QM` → `{ source:{ kind:'watchlist' }, columns:[defaults], groupBy:'none' }` · `QM MAG7` → `{ source:{ kind:'watchlist', name:'MAG7' } }` · `QM IDX=SPX GROUP=GICS_SECTOR_NAME SORT=CHG_PCT_1D:desc` → `{ source:{ kind:'index', id:<SPX> }, groupBy:'GICS_SECTOR_NAME', sort:{ col:'CHG_PCT_1D', dir:'desc' } }`.

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
summary `Live quote grid over a watchlist, index members or a typed list of securities`; description `QM is a monitor: every row is one security and every cell updates from the ticker plant with a flash on change. The source is a watchlist (default: your most recently updated one), an index's current constituents (IDX=SPX from the SPY N-PORT/SSGA membership) or a list of keys. Columns are dictionary fields; sort and group are client-side and remembered in the frame. Rows off screen are marked non-essential so a slow connection widens conflation or sheds them before anything is lost; a stale feed is shown, never silently frozen. Enter opens DES, Q the quote, W saves the rows as a watchlist.`; params `source` ("watchlist name/id, IDX=<index> or KEYS=a,b,c", `MAG7`), `columns` ("field ids", `COLS=PX_LAST,CHG_PCT_1D,PX_VOLUME`), `sort` ("column:dir", `SORT=CHG_PCT_1D:desc`), `groupBy` ("none, GICS_SECTOR_NAME, EXCH_CODE, MARKET_SECTOR_DES", `GROUP=GICS_SECTOR_NAME`); sources `['cboe.quotes','yahoo.chart','coingecko.simple','nyfed.rates','sec.archives','ssga.holdings','wiki.sp500','internal.derived']`; related `['W','Q','DES','MEMB','WEI']`.

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
`filename = 'W_' + nameSlug + '_' + asOfCompact + '.csv'`. Columns are payload-dependent: `position,key,name,` + `active.columns[].id` (field and formula columns) `,label,note`. One row per `active.rows[]`; formula rows put the formula in `key` and their evaluated cells; values from the cached payload at resolve time (formula columns evaluated server-side by the same `core/formula`). `GET /watchlists/:watchlistId/export.csv` (API.md §5.8) runs this resolver with `params { watchlist:{ id } }` and this `csv` spec — one implementation. Example: `1,AAPL US Equity,Apple Inc,330.27,-0.8436,-0.008436,,`.

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
| csv parity | `packages/core/test/functions/csv.test.ts` | `W.default.csv`; `GET /watchlists/:watchlistId/export.csv` (the parameter name API.md §5.8 declares — Fastify route params are named, so `:id` and `:watchlistId` are different params objects) byte-equals PRINT for the same result |
| screen | `packages/web/test/screens/W.test.tsx` | formula cells recompute on an `UpdateEvent` of a dep; `Insert`/`Delete`/`Alt+Arrow` call `sdk.watchlists.setItems` then `setParams`; non-owner has mutations disabled; skeleton |
| e2e | `packages/e2e/tests/watchlist.spec.ts` | `W <GO>`, `Ctrl+N` "e2e", `Insert` `AAPL US Equity`, `F` `PX_LAST/PX_CLOSE_1D-1`; reload restores the list and column (TERM-05); `Ctrl+P` CSV equals the grid |

---

## 99. Additions required by this file

These do not exist in CONTRACTS.md, FUNCTIONS.md, API.md or DATA_MODEL.md and must land before the
resolvers above compile. Nothing else in this file adds to the contract.

| # | Addition | Where it must be declared | Used by |
| --- | --- | --- | --- |
| 1 | `DataServices.curves.history(curveId: string, tenor: string, from: string, to: string, quoteType: CurvePoints['quoteType']): Promise<SeriesBlock>` — a third member of the `curves` service, which FUNCTIONS.md §1.4.2 L298 declares today as `{ points(curveId, date?), build(curveId, date, interpolation?) }`. It reads `curve_points` filtered on `curve_id`, `tenor`, `quote_type` and `curve_date BETWEEN from AND to` with `is_latest` true (one row per curve date; a superseded vintage is never charted), ordered by `curve_date`, and returns the API.md §4 `SeriesBlock` (L334) so HP/GP render a curve tenor with exactly the same series machinery as a price history. It is the reader behind `GET /curves/:curveId/history` (API.md §5.4 L549), which is already in the route table. | `packages/core/src/functions/manifest.ts` (declaration, WP-01); `packages/server/src/data/curves.ts` (implementation, WP-04); `packages/server/src/http/routes/data.ts` (route, WP-08) | HP `series` variant on `govt` curve tenors (§HP, data-services row); GP govt-curve overlay |

---

### TOP — Top News

| Attribute | Value |
| --- | --- |
| Code / aliases | `TOP` / `TOPN` |
| Tier / category | 1 / news |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/TOP.ts` · `packages/server/src/functions/TOP/resolve.ts` · `packages/web/src/screens/TOP/Screen.tsx` · `fixtures/golden/functions/TOP.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (NEWS-01) (NEWS-02) (NEWS-03) (NEWS-07) (NEWS-08) (TERM-06) (TERM-08) (TERM-12) (DATA-09) (DATA-10) (ENTL-01) (ENTL-05) (STOR-04) (OPS-03) |

#### Params
```ts
export const TopParams = z.object({
  scope: z.enum(['auto', 'all', 'feed', 'topic', 'instrument']).default('auto'),
  id: z.string().max(64).optional(),                              // topic code ('FED'), feed name ('markets') or instrument id as a string
  limit: z.number().int().min(10).max(50).default(30),
  kinds: z.array(z.enum(['story', 'video', 'filing', 'press_release', 'fed_release'])).default(['story', 'video', 'filing', 'press_release', 'fed_release']),
});
```
#### Argument grammar
`positional [{ name:'id', type:'string', optional:true }]`, `keyed { SCOPE: { name:'scope', type:'enum', values:['auto','all','feed','topic','instrument'] }, N: { name:'limit', type:'int' }, KIND: { name:'kinds', type:'enum', values:['story','video','filing','press_release','fed_release'], repeat:true } }`, no `rest`.
Examples: `TOP` → `{ scope:'auto', limit:30, kinds:[all five] }` · `TOP FED` → `{ scope:'auto', id:'FED' }` (resolved to `topic`) · `TOP markets N=50 KIND=STORY` → `{ scope:'auto', id:'markets', limit:50, kinds:['story'] }` (resolved to `feed`).
`scope:'auto'` with no `id` resolves to `all`. A security loaded in the panel is **ignored** by TOP (`requiresSecurity:false`): issuer-linked news is `CN`, instrument-scoped ranking is `TOP SCOPE=INSTRUMENT id=<instrumentId>` (TERM-03 leaves the panel security untouched).

#### Payload
```ts
import type { NewsRow } from '../shared/news';                    // §0.2

export type TopPayload = {
  variant: 'default';
  resolved: { scope: 'all' | 'feed' | 'topic' | 'instrument'; id: string | null; label: string /* 'All news' | 'Markets' | 'Federal Reserve' | 'AAPL US Equity' */ };
  rows: Array<NewsRow & { rank: number; rankParts: { recency: number; feedWeight: number; linkConfidence: number; clickThrough: number } }>;   // rank desc, ties → publishedAt desc, then newsId desc
  liveSubject: string;                                            // 'n:all' | 'n:feed:markets' | 'n:topic:FED' | 'n:inst:42'
  feedHealth: Array<{ sourceId: 'bbg.rss' | 'sec.atom' | 'fed.rss'; feed: string; lastCapturedAt: string | null; expectedIntervalMs: number;
                      st: 'live' | 'stale' | 'blank'; provIdx: number }>;                                                    // TERM-12
  suppressed: { entitlement: number; kindFilter: number };        // rows dropped before `rows` was built, so the screen can say so (ENTL-05)
  asOf: string;                                                   // ISO, ctx.asOf.validAt
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `news_items` (`tsv` unused here; ordered by `published_at`), `news_entity_links`, `topics`, `instruments` (current, for `n:inst:` label and link display), `issuers` (current, link display), `provenance` (per `news_items.provenance_id`), `licence_registry` (`display`, `export_allowed`, `attribution`, `intrinsic_delay_min`), `usage_events` (7-day click-through aggregate, `kind='search.select'`, `details->>'newsId'`), `ingest_runs` (`feedHealth.lastCapturedAt` per `job_id`) |
| Data services (§1.4.2) | `data.news.top(scope, id, limit)` (→ `GET /news/top`, ranked by `packages/server/src/news/ranker.ts`), `data.news.topics()` (topic label), `data.reference.instrument(id)` (instrument-scope label only) |
| Read-through (`providers.ensure`) | `('bbg.rss', feed, { maxAgeMs: 60_000 })` for each of the six Bloomberg feeds when `feedHealth[i].st !== 'live'` and `usage !== 'export'`; `('fed.rss', 'press_all', { maxAgeMs: 300_000 })` when the `fed.rss` line is stale. **No read-through exists for `sec.atom`** (`ReadThroughKind` has no such member, FUNCTIONS.md §1.4.2): 8-K headlines arrive only from the `sec.8kAtom` scheduler job, and a stale `sec.atom` line is reported in `feedHealth` with `st:'stale'` and never refetched inline. |
| Engines (`core/analytics`) | None. |
| Subjects (live) | exactly one of `n:all`, `n:feed:<feed>`, `n:topic:<code>`, `n:inst:<instrumentId>` (API.md §6.1) |
| Field ids (`fieldIds(assetClass)`) | `default: []` — `n:` subjects are subscribed with `f: []` ("all fields of the subject", API.md §6.1); the subject's dictionary fields are `NEWS_ID HEADLINE PUBLISHED_AT SOURCE_ID LINK KIND IS_CORRECTION` (`fieldClass:'news'`, `assetClasses: []`). The entitlement pre-check set is therefore the **source** set `['bbg.rss','sec.atom','fed.rss']` against `field_licence` `field_class='news'`, not a field list. |

#### Resolver
1. Resolve scope. `scope:'auto'` → `id` absent: `{ scope:'all', id:null, label:'All news' }`; `id` present: uppercase match on `topics.code` → `topic` (label `topics.name`); else lowercase match on the distinct `news_items.feed` values → `feed` (label = feed title-cased); else `/^\d+$/` → `instrument` (label = `data.reference.instrument(Number(id)).display`); else `ctx.unavailable.add({ field:'scope', reason:'NOT_APPLICABLE', detail:`UNKNOWN_SCOPE: '${id}' is neither a topic code, a feed nor an instrument id` })` and fall back to `all` (NEWS-01: the screen always shows something).
2. `feedHealth`: one query over `ingest_runs` (`job_id IN ('bbg.rss.markets', …, 'fed.press.poll', 'sec.8kAtom')`, latest `finished_at` with `status='ok'`) joined to `licence_registry` for `expected` cadence; `st = 'live'` when `now − lastCapturedAt ≤ 3 × expectedIntervalMs`, `'stale'` beyond that (the `valueState` rule of ARCHITECTURE §4.2 applied to a feed), `'blank'` when the job never ran; `provIdx = ctx.prov.add({ sourceId, provenanceId, capturedAt, sourceTs:null, st, tier:'delayed' })`.
3. Read-through per the table above for any `bbg.rss` / `fed.rss` line that is not `live`. A `ProviderUnavailableError` is caught, not rethrown: the line keeps `st:'stale'` and `ctx.unavailable.add({ field:'feedHealth.<sourceId>', reason:'NO_SOURCE', detail:'PROVIDER_DOWN: serving stored headlines' })` (TERM-12 — never silently fresh).
4. `items = await data.news.top(resolved.scope, resolved.id ?? undefined, params.limit + 20)` — the ranker over-fetches so the `kinds` filter does not shorten the page.
5. Filter by `params.kinds`, counting drops into `suppressed.kindFilter`. Filter by licence: a row whose `source_id` has no `display` grant for `ctx.user.firmId` (evaluator rule 3, ARCHITECTURE §10) is dropped into `suppressed.entitlement` and its `FieldDecision` is recorded in `meta.entitlement` once per source with `reason:'NO_FIRM_ENTITLEMENT'` (ENTL-05). Access is logged per source, not per headline (one `access_log` row per distinct `source_id` with `field_class:'news'`, `purpose:'TOP'`).
6. Map to `NewsRow` (§0.2), truncate to `params.limit`, attach `rank`/`rankParts` from the ranker (`recency = exp(−ageMinutes / 180)`; `feedWeight` from `topics.kind` and source — `bbg.rss markets` 1.0, other bbg feeds 0.8, `fed.rss` 0.9, `sec.atom` 0.6; `linkConfidence = max(links[].confidence)` or 0.5 when unlinked; `clickThrough` = 7-day `usage_events` selects / impressions, `0` before any history with `ctx.unavailable.add({ field:'rows[].rankParts.clickThrough', reason:'NO_SOURCE', detail:'NO_CLICKTHROUGH_HISTORY: fewer than 7 days of usage events' })`). `machineGenerated` is `false` on every row (NEWS-08); the ingest never writes `true` in v1.
7. `provIdx` per row from `ctx.prov.add({ sourceId: row.sourceId, provenanceId: news_items.provenance_id, capturedAt, sourceTs: publishedAt, st:'closed', tier:'delayed' })` — a headline is an immutable stored record, not a live cell (§0.4 rule 3).
8. Return. Budget: 2 DB round-trips (ranker query + `feedHealth`) plus at most 1 provider call; first paint < 500 ms p95, 0 provider calls when the scheduler is healthy.

#### Live
`{ subjects: [payload.liveSubject], fields: [], essential: [payload.liveSubject] }` — `conflationMs` is omitted because `n:` is **not conflated** (API.md §6.1: one `delta` per headline, in `publishedAt` order). `packages/web/src/screens/TOP/Screen.tsx` prepends each `delta` as a new `list#rows` item with `rank = rows[0].rank + 1` (a live headline always sorts first, its rank is recomputed on the next `launchKind:'refresh'`), flashes it for 2 s (TERM-08), caps the list at `params.limit` and drops the tail. NEWS-03 budget: RSS receipt → screen < 1 s.

#### Screen
```
┌ TOP · Top News · All news                                   30 headlines · 18:41:28 · ● bbg.rss ● fed.rss ◐ sec.atom ┐
│ badges#health   [bbg.rss markets 18:40:06 live] [fed.rss 18:12:40 live] [sec.atom 18:21:20 STALE 20m]               │
│ list#rows  (newsList('rows', rows, { showFeed:true, showKind:true, showRank:true, dense:true }))                    │
│  15:04  MKT  ▶  AI Will Be Biggest 'Misallocation' of Capital, Says Noble          [CORRECTION]   0.9412            │
│  14:21  FIL  ▤  8-K · Aerkomm Inc · Item 5.02 Departure of Directors                AERK US       0.5108            │
│  13:55  FED  ◆  Federal Reserve Board announces …                                   FED           0.7730            │
│ text#suppressed  3 headlines hidden by KIND filter · 0 hidden by entitlement                                        │
│ footer sources: Bloomberg RSS (headlines and link only, no article body); SEC EDGAR 8-K current-filings Atom;        │
│                 Federal Reserve press releases — asOf 2026-09-15T18:41:28Z                                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `TOP · Top News · <resolved.label>`; subtitle `<rows.length> headlines · <asOf HH:mm:ss in the user's tz> · <feedHealth glyphs>`; `initialFocus:'rows'`. Columns of `list#rows`: published time (`fmt:'datetime'`, time-only for today, `dd/MM HH:mm` otherwise), a three-letter feed tag, a kind glyph (`▶` video, `▤` filing, `◆` press_release/fed_release, blank story), the headline (`fmt:'text'`, never truncated below 60 chars — the list wraps), the linked entities (`links[].display`, up to two, `+n` beyond), `[CORRECTION]` badge when `isCorrection`, and `rank` (`fmt:'pct'`-style 4 decimals, hidden when the panel is narrower than 100 cols). A row with `machineGenerated === true` would render in a separate muted block under a `Machine-generated` divider (NEWS-08); v1 never produces one and the screen asserts that in its test. Skeleton while `payload === undefined`: `badges#health` with three muted chips and ten muted list rows. `meta.unavailable` entries render as one muted line under the list; `meta.entitlement` denials render as the `text#suppressed` line with the source name and reason.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | list (`list#rows`) | `open-story` | `ctx.openUrl(row.url)` in a new tab (link-out only — no body is stored, DATA_MODEL §10) and emit `usage_events { kind:'search.select', code:'TOP', details:{ newsId, rank: row.rank } }` (the ranker's click-through input) |
| `Shift+Enter` | list | `open-story-next` | `ctx.navigateNext('N ' + row.newsId)` — the N reader in the next panel |
| `Ctrl+I` | list | reserved provenance | `ctx.provenance(row.provIdx)` — feed URL, `request_key`, captured-at, raw fixture (DATA-10) |
| `S` | always | `open-security` | `ctx.navigate(row.links.find(l => l.entityKind === 'instrument')?.display + ' DES')`; no instrument link → no-op with a `notice` |
| `N` | always | `open-n` | `ctx.navigate('N ' + JSON.stringify(row.headline.slice(0, 40)))` — the same headline as a search |
| `I` | always | `open-ni` | `ctx.navigate('NI ' + (row.links.find(l => l.entityKind === 'topic')?.display ?? resolved.id ?? ''))` |
| `C` | always | `cycle-scope` | `ctx.setParams({ scope: next of ['all','feed','topic'] })` (usage `fn.param`) |
| `K` | always | `cycle-kinds` | `ctx.setParams({ kinds })` cycling all → stories only → filings only |
| `+` / `-` | always | `more` / `fewer` | `ctx.setParams({ limit: clamp(limit ± 10, 10, 50) })` |
| `A` | list | `alert-on-scope` | `sdk.alerts.create({ condition: { kind:'news', query: { topic: resolved.scope === 'topic' ? resolved.id : undefined, feed: resolved.scope === 'feed' ? resolved.id : undefined } } })` (NEWS-07) |

#### CSV
`filename = 'TOP_' + (resolved.id ?? 'ALL') + '_' + asOfCompact + '.csv'` (`asOfCompact = asOf.replace(/[-:]/g,'')`). Columns = `newsCsvColumns` (§0.5) with one appended column `{ id:'rank', label:'Rank', type:'number', decimals:4 }`; rows = `rows.map(r => [...newsCsvRow(r), r.rank])`. Single-block, so no `section` column. Rows whose `source_id` has `licence_registry.export_allowed = false` are omitted and counted in a `# suppressed: <n> rows (NOT_LICENSED_EXPORT: <sourceId>)` header comment above the `# asOf` line (ENTL-01, API.md §9); `attribution` carries one line per surviving source from `licence_registry.attribution`. Example row: `2026-09-15T15:04:08Z,bbg.rss,markets,video,"AI Will Be Biggest 'Misallocation' of Capital, Says Noble",https://www.bloomberg.com/news/videos/2026-09-15/ai-will-be-biggest-reallocation-of-capital-says-noble-video,,true,1041,0.9412`.

#### Help
summary `Ranked headline feed by topic, feed or security, with live prepend`; description `TOP is the ranked front page of the normalised news stream: Bloomberg RSS headlines, SEC 8-K current filings and Federal Reserve press releases in one list, newest and most relevant first. Ranking combines recency, the weight of the feed, the confidence of the entity link and how often the desk opens that kind of headline. Only headlines, summaries and links are stored — article bodies stay with the publisher, so Enter opens the story on the publisher's site. Headlines arrive live: a new story is prepended and flashed within a second of receipt, never overwriting an earlier one. The health chips show when each feed was last captured; a feed that stops publishing goes stale rather than silently empty. Nothing on this screen is machine-generated.`; params `scope` ("all, feed, topic or instrument", `SCOPE=TOPIC`), `id` ("topic code, feed name or instrument id", `FED`), `limit` ("10–50 headlines", `N=50`), `kinds` ("story, video, filing, press_release, fed_release", `KIND=FILING`); sources `['bbg.rss','sec.atom','fed.rss']`; related `['N','NI','CN','DES','MSG']`.

#### Unavailable and reason codes
`{ field:'scope', reason:'NOT_APPLICABLE', detail:"UNKNOWN_SCOPE: '<id>' is neither a topic code, a feed nor an instrument id" }` (falls back to `all`); `{ field:'feedHealth.<sourceId>', reason:'NO_SOURCE', detail:'PROVIDER_DOWN: serving stored headlines' }` when a read-through circuit is open; `{ field:'feedHealth.sec.atom', reason:'NO_SOURCE', detail:'NO_READ_THROUGH_SEC_ATOM: 8-K headlines refresh only on the scheduler tick' }` whenever the `sec.atom` line is stale; `{ field:'rows[].rankParts.clickThrough', reason:'NO_SOURCE', detail:'NO_CLICKTHROUGH_HISTORY: fewer than 7 days of usage events' }`; `{ field:'rows[].summary', reason:'NOT_LICENSED', detail:'NO_BODY_LICENCE: headline, summary and link only — the article body is never stored' }` (always present for `bbg.rss` rows, rendered once in the footer). Entitlement: per-source `NO_FIRM_ENTITLEMENT` in `meta.entitlement` with the count in `suppressed.entitlement`; export-side `NOT_LICENSED_EXPORT` as a CSV header comment. `eod@demo` sees the full list — news is `field_class:'news'` and carries no latency tier, so `TIER_EOD` never applies here (ENTL-05).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/TOP.golden.test.ts` | seeded from `bbg-rss-{markets,econ,politics,tech,industries}`, `fed-press-rss.xml`, `sec-8k-atom.xml` at the frozen clock `2026-09-15T18:41:28Z`, deep-equals `TOP.default.json`; `rows[0].headline === "AI Will Be Biggest 'Misallocation' of Capital, Says Noble"`, `rows[0].sourceId === 'bbg.rss'`, `rows[0].feed === 'markets'`, `rows[0].kind === 'video'`, `rows[0].publishedAt === '2026-09-15T15:04:08.000Z'`, `rows[0].isCorrection === true`; the 8-K row has `kind:'filing'`, `cik:'0001590496'`, `items8k:['5.02']`, `publishedAt === '2026-09-15T18:21:20.000Z'`; every row `machineGenerated === false` |
| resolver unit | `packages/server/test/unit/functions/TOP.scope.test.ts` | `scope:'auto'` resolves `'FED'` → topic, `'markets'` → feed, `'42'` → instrument, `'zzz'` → `all` + the `UNKNOWN_SCOPE` unavailable entry; `kinds` filtering increments `suppressed.kindFilter` |
| ranker | `packages/server/test/unit/news/ranker.test.ts` | monotone in each `rankParts` component with the others fixed; ties break on `publishedAt` then `newsId`; `clickThrough === 0` with no `usage_events` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(TOP golden))` equals `TOP.default.csv`; `rank` column equals `rows[i].rank`; a source with `export_allowed=false` produces the `# suppressed` comment and omits those rows |
| parity | `packages/server/test/parity/fn-parity.test.ts` | `rows[0]` fields equal the `n:all` WS `snap` values (`NEWS_ID HEADLINE PUBLISHED_AT SOURCE_ID LINK KIND IS_CORRECTION`) at the frozen clock (API-05) |
| screen | `packages/web/test/screens/TOP.test.tsx` | renders the golden; an `n:all` `delta` prepends and flashes one row and the list stays at `limit`; `C`/`K`/`+`/`-` call `setParams`; `Enter` calls `ctx.openUrl` and emits `search.select`; a stale `feedHealth` row renders the amber chip; no row renders in the machine-generated block; skeleton |
| staleness | `packages/server/test/integration/functions/TOP.stale.test.ts` | with `ingest_runs` aged past `3 × expectedIntervalMs` and the circuit open, `feedHealth[i].st === 'stale'`, the `PROVIDER_DOWN` unavailable entry is present, rows are still served, nothing throws (TERM-12) |
| e2e | `packages/e2e/tests/news.spec.ts` | the morning flow: `TOP <GO>` paints ranked headlines; the replay feed pushes a headline that appears at the top within 1 s (NEWS-03); `Enter` opens the publisher URL in a new tab; `S` on a linked row lands on `DES`; `Ctrl+P` downloads `TOP_ALL_*.csv` |

---

### N — News Search

| Attribute | Value |
| --- | --- |
| Code / aliases | `N` / `NEWS` |
| Tier / category | 1 / news |
| Asset classes → variants | `any (optional security) → default` |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/N.ts` · `packages/server/src/functions/N/resolve.ts` · `packages/web/src/screens/N/Screen.tsx` · `fixtures/golden/functions/N.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (NEWS-01) (NEWS-02) (NEWS-07) (NEWS-08) (TERM-03) (TERM-06) (TERM-11) (TERM-12) (DATA-09) (DATA-10) (ENTL-01) (ENTL-05) (STOR-04) |

#### Params
```ts
export const NParams = z.object({
  q: z.string().max(200).optional(),                              // websearch_to_tsquery syntax: bare words, "phrases", -exclusions, OR
  scope: z.enum(['all', 'security']).default('all'),              // 'security' pins the query to the panel's loaded instrument (TERM-03)
  feeds: z.array(z.string().max(32)).default([]),
  topics: z.array(z.string().max(32)).default([]),                // topics.code
  kinds: z.array(z.enum(['story', 'video', 'filing', 'press_release', 'fed_release'])).default([]),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  pageSize: z.number().int().min(10).max(200).default(50),
  savedSearchId: z.number().int().optional(),                     // loads saved_searches.query and merges it under the explicit params
});
```
#### Argument grammar
`positional []`, `keyed { Q: { name:'q', type:'string' }, SCOPE: { name:'scope', type:'enum', values:['all','security'] }, FEED: { name:'feeds', type:'string', repeat:true }, TOPIC: { name:'topics', type:'string', repeat:true }, KIND: { name:'kinds', type:'enum', values:['story','video','filing','press_release','fed_release'], repeat:true }, FROM: { name:'from', type:'date' }, TO: { name:'to', type:'date' }, ROWS: { name:'pageSize', type:'int' }, SAVED: { name:'savedSearchId', type:'int' } }`, `rest { name:'q', type:'string', join:' ' }` — everything after the function code that is not a `KEY=value` token becomes the query text.
Examples: `N rate cut` → `{ q:'rate cut', scope:'all', pageSize:50 }` · `AAPL US Equity N` → `{ scope:'security', pageSize:50 }` with `security = 42` (a security in the panel flips the default scope to `security`, TERM-03) · `N Q="tender offer" KIND=FILING FROM=2026-09-01 ROWS=100` → `{ q:'tender offer', kinds:['filing'], from:'2026-09-01', pageSize:100 }`.

#### Payload
```ts
import type { NewsRow } from '../shared/news';                    // §0.2

export type NPayload = {
  variant: 'default';
  query: { q: string | null; instrumentId: number | null; instrumentDisplay: string | null; feeds: string[]; topics: string[];
           kinds: NewsRow['kind'][]; from: string | null; to: string | null };          // the query actually executed, after saved-search merge
  matcher: 'tsquery' | 'trigram' | 'none';                        // 'trigram' = websearch_to_tsquery matched 0 rows and pg_trgm on headline was used
  tsquery: string | null;                                         // websearch_to_tsquery(...)::text, echoed so the user can see what was searched
  rows: NewsRow[];                                                // published_at desc, newsId desc — never re-ranked (N is chronological, TOP is ranked)
  total: number;                                                  // capped at 1000 by the resolver; `totalIsCapped` says so
  totalIsCapped: boolean;
  nextCursor: string | null;                                      // base64url(JSON.stringify({ publishedAt, newsId })) of the last row
  savedSearch: { searchId: number; name: string } | null;
  feedHealth: TopPayload['feedHealth'];                           // same shape and rule as TOP (TERM-12)
  suppressed: { entitlement: number };
  asOf: string;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `news_items` (`tsv` — `setweight(headline,'A') || setweight(summary,'B')`, GIN; `pg_trgm` index on `headline` for the fallback), `news_entity_links` (instrument / topic filters), `topics`, `instruments` (current, for the display of `scope:'security'` and of `links[]`), `issuers` (link display), `saved_searches` (`kind='news'`), `provenance`, `licence_registry`, `ingest_runs` (`feedHealth`) |
| Data services (§1.4.2) | `data.news.search(NewsQuery)` (→ `GET /news`, returns `{ items, nextCursor, total }`), `data.reference.resolve(ref)` (only when `scope:'security'`), `data.news.topics()` (validating `params.topics`) |
| Read-through (`providers.ensure`) | None. A search reads the stored corpus only: a search must be reproducible and pageable, and refetching a feed mid-page would reorder results. Freshness is reported through `feedHealth`, and `R` re-runs the function (`launchKind:'refresh'`). |
| Engines (`core/analytics`) | None. |
| Subjects (live) | `n:inst:<instrumentId>` when `scope:'security'`; `n:topic:<code>` when exactly one topic and no `q`; `n:feed:<feed>` when exactly one feed and no `q`; otherwise **none** (a text query cannot be evaluated on the wire — the screen shows `text#livenote` "live prepend off for text queries; press R to re-run") |
| Field ids (`fieldIds(assetClass)`) | `default: []` — `n:` subjects subscribe with `f: []` (API.md §6.1). Entitlement pre-check is over sources `['bbg.rss','sec.atom','fed.rss']`, `field_class='news'` |

#### Resolver
1. Merge the query. When `params.savedSearchId` is set, load `saved_searches` (owner must be `ctx.user.userId`, else `ctx.unavailable.add({ field:'savedSearch', reason:'NOT_APPLICABLE', detail:'SAVED_SEARCH_NOT_YOURS' })` and continue without it); explicit params win field by field over the saved `query` jsonb.
2. Resolve the security. `scope:'security'` requires `ctx.security` (the panel's instrument, passed by `toRunRequest`); missing → `ctx.unavailable.add({ field:'query.instrumentId', reason:'NOT_APPLICABLE', detail:'NO_SECURITY_LOADED: N SCOPE=SECURITY needs a security in the panel' })` and fall back to `scope:'all'`. Present → `query.instrumentId = ctx.security.instrumentId`, `instrumentDisplay = ctx.security.display`.
3. Validate `params.topics` against `data.news.topics()`; each unknown code → `ctx.unavailable.add({ field:'query.topics', reason:'NOT_APPLICABLE', detail:'UNKNOWN_TOPIC: <code>' })` and is dropped. Same for `feeds` against the distinct `news_items.feed` values (`UNKNOWN_FEED: <feed>`).
4. `data.news.search({ q, instrumentId, topic, feed, kinds, from, to, cursor: ctx.page.cursor, limit: params.pageSize })`. The route runs `websearch_to_tsquery('english', q)` against `news_items.tsv`; when `q` is set and the tsquery returns 0 rows it re-runs with `headline % q` (pg_trgm, `similarity ≥ 0.3`, ordered by `published_at desc`) and the payload records `matcher:'trigram'`. `q` absent → `matcher:'none'` (pure filter query, chronological).
5. `total` is `count(*)` with `LIMIT 1001`; `total > 1000` → `total = 1000`, `totalIsCapped = true` (STOR-04: the corpus is unbounded, the count is not worth a full scan).
6. Licence filter and per-source access logging exactly as TOP step 5 (`purpose:'N'`); drops counted in `suppressed.entitlement`.
7. `feedHealth` exactly as TOP step 2 (shared helper `packages/server/src/functions/shared/feedHealth.ts`). No read-through (see the table).
8. Map to `NewsRow`; `provIdx` per row as TOP step 7. `machineGenerated` is `false` on every row (NEWS-08).
9. Paging: `nextCursor = base64url(JSON.stringify({ publishedAt: last.publishedAt, newsId: last.newsId }))`; `ctx.page.set({ index: ctx.page.index, count: Math.ceil(Math.min(total, 1000) / params.pageSize), cursor: nextCursor })`. **PAGE FWD = older headlines** (the sort is `published_at desc`), PAGE BACK re-runs with the previous cursor held in the frame stack. The cursor is a keyset, so a headline arriving mid-paging never duplicates or skips a row.
10. Return. Budget: 1 DB round-trip for the search (GIN or trigram index, both index-only on the first 50 rows), 1 for `feedHealth`, 1 for `saved_searches` when requested; first paint < 500 ms p95, 0 provider calls.

#### Live
`{ subjects: <zero or one subject per the Data-dependencies table>, fields: [], essential: [] }` or `null` when the query is textual. When a subject is present, `packages/web/src/screens/N/Screen.tsx` prepends an arriving headline **only when it satisfies the client-side filters it can evaluate** (`kinds`, `feeds`, `from`/`to`) and marks it with a `NEW` chip; it never re-sorts the page and never changes `total` (the count is the count at `asOf`). On page 2 and beyond (`ctx.page.index > 0`) live prepend is disabled, because prepending onto a keyset page would break the cursor contract; the screen says so in `text#livenote`.

#### Screen
```
┌ N · News Search · "rate cut" · all sources                     page 1/6 · 284 hits · tsquery · 18:41:28 ┐
│ form#query   q [rate cut          ] scope (all|security) feeds [markets,economics] topics [FED]         │
│              kinds [story,filing]  from [2026-09-01] to [ ]  rows [50]        saved: "Fed watch"        │
│ text#matcher  websearch_to_tsquery: 'rate' & 'cut'   ·  284 hits (exact)                                │
│ list#rows  (newsList('rows', rows, { showFeed:true, showKind:true, showSummary:true, highlight:tsquery }))│
│  15 Sep 13:55  FED  ◆  Federal Reserve Board announces …                              FED               │
│                        …summary with the matched terms marked…                                          │
│  15 Sep 11:02  ECO  ·  Traders Trim Bets on an October Cut                            USGG10YR Index    │
│ text#livenote  live prepend off for text queries — press R to re-run                                     │
│ footer sources: Bloomberg RSS (headline, summary and link only); SEC EDGAR 8-K Atom; Federal Reserve     │
│        press releases · page 1/6 · PAGE FWD = older · asOf 2026-09-15T18:41:28Z                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `N · News Search · <q ?? 'all headlines'> · <instrumentDisplay ?? 'all sources'>`; subtitle `page <index+1>/<count> · <total><totalIsCapped ? '+' : ''> hits · <matcher> · <asOf time>`; `initialFocus:'rows'` (`initialFocus:'query'` when `q` is absent and no filter is set, so an empty `N` lands in the form). `form#query` fields are `FormField`s (`q` text, `scope` enum, `feeds`/`topics`/`kinds` text with comma lists, `from`/`to` date, `pageSize` number); editing one and pressing `Enter` calls `ctx.setParams` (usage `fn.param`). `matcher:'trigram'` renders `text#matcher` in amber: `no exact match — showing approximate headline matches (pg_trgm)` with footer code `TRIGRAM_FALLBACK`. `matcher:'none'` hides the tsquery line. Matched terms are marked in headline and summary by the client from `tsquery` (`<mark>`-equivalent tone), never by the server. Skeleton: the form with the current params and twelve muted rows. `meta.entitlement` denials render as one muted line above the list with the source name and `NO_FIRM_ENTITLEMENT`.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | list (`list#rows`) | `open-story` | `ctx.openUrl(row.url)` (link-out only) + `usage_events { kind:'search.select', code:'N', details:{ newsId } }` |
| `Shift+Enter` | list | `open-story-next` | `ctx.navigateNext(row.links[0]?.display + ' DES')` when the row has an instrument link, else `ctx.openUrl(row.url)` |
| `Enter` | form (`form#query`) | `apply-query` | `ctx.setParams(form.values)` and reset to page 1 |
| `PageDown` / `PageUp` | always | reserved PAGE FWD / BACK | `ctx.page('fwd')` (older) / `ctx.page('back')` (newer) |
| `Ctrl+I` | list | reserved provenance | `ctx.provenance(row.provIdx)` (DATA-10) |
| `/` | always | `focus-query` | move focus to `form#query.q` |
| `R` | always | `refresh` | re-run with `launchKind:'refresh'` (no `fn.param` usage row, API.md §5.3) |
| `S` | always | `save-search` | `ctx.prompt('name')` → `sdk.alerts.savedSearches.create({ kind:'news', name, query })` (NEWS-07) — saved searches hang off the `alerts` namespace (`TerminalClient.alerts.savedSearches: SavedSearchesApi`, API.md §10 L1257); there is no top-level `sdk.savedSearches` |
| `A` | always | `alert-on-query` | `sdk.alerts.create({ condition: { kind:'news', savedSearchId } })` when saved, else `{ kind:'news', query: { q, instrumentId, topic, feed } }` (NEWS-07) |
| `K` | always | `cycle-kinds` | `ctx.setParams({ kinds })` cycling all → stories → filings |
| `T` | always | `open-top` | `ctx.navigate('TOP')` |
| `I` | always | `open-ni` | `ctx.navigate('NI ' + (query.topics[0] ?? ''))` |

#### CSV
`filename = 'N_' + (query.instrumentDisplay ? displaySlug + '_' : '') + (q ? slug(q) : 'ALL') + '_' + asOfCompact + '.csv'`. Columns = `newsCsvColumns` (§0.5) verbatim; rows = `rows.map(newsCsvRow)` — **the current page only**, and the header carries `# page: <index+1>/<count>` plus `# query: <JSON of payload.query>` and `# matcher: <matcher>` so an exported page is self-describing (FUNCTIONS.md §10 Q4). `Ctrl+E` on the list exports the same columns for up to 1000 rows across pages via `/data/csv` (the export path re-runs the query server-side with `limit: 1000`; the extra rows are entitlement-filtered again). Export licence filtering and the `# suppressed` comment are as TOP. Example row: `2026-09-15T18:21:20Z,sec.atom,8-K,filing,8-K · Aerkomm Inc. · Item 5.02,https://www.sec.gov/Archives/edgar/data/1590496/000121390026100070/0001213900-26-100070-index.htm,,false,1188`.

#### Help
summary `Full-text and filtered search over the normalised news stream`; description `N searches every headline and summary the platform has captured — Bloomberg RSS, SEC 8-K current filings and Federal Reserve press releases — using Postgres full-text search with the same stemming and phrase syntax as a web search: bare words are ANDed, "quoted phrases" are exact, a leading minus excludes, OR widens. When nothing matches exactly, N falls back to approximate headline matching and says so. Filters narrow by feed, topic, kind of item and date range; typing a security before N pins the search to that security's linked stories. Results are chronological, newest first — TOP is the ranked view. Pages move backwards in time: PAGE FWD shows older headlines. A search can be saved and turned into an alert that fires on the next matching headline. Article bodies are not stored; Enter opens the story at the publisher.`; params `q` ("search text, websearch syntax", `"tender offer" -earnings`), `scope` ("all or the panel's security", `SCOPE=SECURITY`), `feeds` ("feed names, repeatable", `FEED=markets`), `topics` ("topic codes, repeatable", `TOPIC=FED`), `kinds` ("item kinds, repeatable", `KIND=FILING`), `from` / `to` ("ISO dates", `FROM=2026-09-01`), `pageSize` ("10–200 rows", `ROWS=100`), `savedSearchId` ("load a saved search", `SAVED=3`); sources `['bbg.rss','sec.atom','fed.rss']`; related `['TOP','NI','CN','CF','DES']`.

#### Unavailable and reason codes
`{ field:'query.instrumentId', reason:'NOT_APPLICABLE', detail:'NO_SECURITY_LOADED: N SCOPE=SECURITY needs a security in the panel' }`; `{ field:'query.topics', reason:'NOT_APPLICABLE', detail:'UNKNOWN_TOPIC: <code>' }`; `{ field:'query.feeds', reason:'NOT_APPLICABLE', detail:'UNKNOWN_FEED: <feed>' }`; `{ field:'savedSearch', reason:'NOT_APPLICABLE', detail:'SAVED_SEARCH_NOT_YOURS' }`; `{ field:'rows', reason:'NO_SOURCE', detail:'TRIGRAM_FALLBACK: no exact match for the query; showing approximate headline matches' }` when `matcher === 'trigram'`; `{ field:'total', reason:'NOT_APPLICABLE', detail:'TOTAL_CAPPED_1000: more than 1000 matches; narrow the query' }` when `totalIsCapped`; `{ field:'rows[].summary', reason:'NOT_LICENSED', detail:'NO_BODY_LICENCE: headline, summary and link only' }` for `bbg.rss` rows; `{ field:'live', reason:'NOT_APPLICABLE', detail:'NO_LIVE_FOR_TEXT_QUERY: text queries cannot be evaluated on the wire' }` when `live()` returns `null`. Entitlement: per-source `NO_FIRM_ENTITLEMENT` with the count in `suppressed.entitlement`; export-side `NOT_LICENSED_EXPORT` as a CSV header comment. No latency tier applies to `field_class:'news'`, so `TIER_EOD` never appears (ENTL-05).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/N.golden.test.ts` | seeded from the five `bbg-rss-*`, `fed-press-rss.xml` and `sec-8k-atom.xml` at the frozen clock, deep-equals `N.default.json` for `N Q="capital"`: `matcher === 'tsquery'`, `tsquery === "'capit'"`, `rows[0].newsId` is the `TLEUW0KGZAKZ00` item, `rows` are strictly descending by `(publishedAt, newsId)`, `machineGenerated === false` on every row |
| resolver unit | `packages/server/test/unit/functions/N.query.test.ts` | saved-search merge order (explicit params win); unknown topic/feed dropped with the `UNKNOWN_*` unavailable entry; `scope:'security'` without `ctx.security` degrades to `all` with `NO_SECURITY_LOADED`; `AAPL US Equity N` filters to `news_entity_links` rows for instrument 42 with `confidence ≥ 0.9` only (NEWS-02) |
| trigram fallback | `packages/server/test/integration/functions/N.trigram.test.ts` | `q:'misalocation'` (typo) returns 0 tsquery rows, then ≥ 1 trigram row, `matcher === 'trigram'`, the `TRIGRAM_FALLBACK` unavailable entry is present |
| paging | `packages/server/test/integration/functions/N.page.test.ts` | `pageSize 10` over the seeded corpus: `meta.page.count === ceil(total/10)`; the page-1 cursor decodes to `{ publishedAt, newsId }` of row 10; PAGE FWD returns strictly older rows with no overlap; inserting a newer headline between pages changes neither page 2's rows nor `total` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(N golden))` equals `N.default.csv`; every column matches `newsCsvColumns`; the `# page` and `# query` comment lines are present |
| parity | `packages/server/test/parity/fn-parity.test.ts` | for `AAPL US Equity N`, `rows[0]` equals the `n:inst:42` WS `snap` values at the frozen clock (API-05) |
| screen | `packages/web/test/screens/N.test.tsx` | renders the golden; `form#query` edit + `Enter` calls `setParams` and resets the page; `PageDown` calls `ctx.page('fwd')`; `S` prompts and calls `alerts.savedSearches.create`; `A` calls `alerts.create`; `matcher:'trigram'` renders the amber notice; live prepend is suppressed on page 2; skeleton |
| e2e | `packages/e2e/tests/news.spec.ts` | continuing the morning flow: from `TOP`, `N` with `Q="Fed"` returns hits; `PageDown` shows older headlines and the footer page counter advances; `S` saves "Fed watch" and `A` arms an alert that the replayed feed fires into the `alerts:me` stream (NEWS-07) |

---

### NI — News by Topic

| Attribute | Value |
| --- | --- |
| Code / aliases | `NI` / `NEWSI` |
| Tier / category | 1 / news |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/NI.ts` · `packages/server/src/functions/NI/resolve.ts` · `packages/web/src/screens/NI/Screen.tsx` · `fixtures/golden/functions/NI.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (NEWS-01) (NEWS-02) (NEWS-03) (NEWS-07) (NEWS-08) (TERM-02) (TERM-06) (TERM-12) (DATA-09) (DATA-10) (ENTL-01) (ENTL-05) (STOR-04) |

#### Params
```ts
export const NiParams = z.object({
  topic: z.string().max(32).optional(),                           // topics.code, case-insensitive on input; absent → the browser
  limit: z.number().int().min(10).max(100).default(40),
  kinds: z.array(z.enum(['story', 'video', 'filing', 'press_release', 'fed_release'])).default([]),
  includeChildren: z.boolean().default(true),                     // roll child topics (topics.parent_topic_id) into the headline list
});
```
#### Argument grammar
`positional [{ name:'topic', type:'string', optional:true }]`, `keyed { N: { name:'limit', type:'int' }, KIND: { name:'kinds', type:'enum', values:['story','video','filing','press_release','fed_release'], repeat:true }, CHILDREN: { name:'includeChildren', type:'boolean' } }`, no `rest`.
Examples: `NI` → `{ limit:40, kinds:[], includeChildren:true }` (topic browser, no topic selected) · `NI FED` → `{ topic:'FED' }` · `NI TECH N=100 CHILDREN=N` → `{ topic:'TECH', limit:100, includeChildren:false }`.
Topic codes are in the autocomplete universe snapshot (TERM-02, FUNCTIONS.md §3.1), so `NI FE` offers `NI FED`.

#### Payload
```ts
import type { NewsRow } from '../shared/news';                    // §0.2

/** One node of the topic browser; `count24h` is the headline count in the last 24 h at asOf. */
export interface NiTopicNode {
  topicId: number; code: string; name: string; kind: 'feed' | 'sector' | 'theme' | 'region' | 'event' | 'release';
  parentCode: string | null; childCodes: string[];
  linkMethods: Array<'feed_topic' | 'keyword' | 'manual'>;        // how headlines reach this topic — [] means no source (see reason codes)
  count24h: number; count7d: number; lastPublishedAt: string | null;
  reason: 'TOPIC_NO_SOURCE' | null;                               // set when linkMethods is empty
}

export type NiPayload = {
  variant: 'default';
  topics: NiTopicNode[];                                          // the whole tree, parents before children, alphabetical within a level
  selected: NiTopicNode | null;                                   // null → browser only, `rows` is []
  rolledCodes: string[];                                          // selected.code plus its descendants when includeChildren
  rows: NewsRow[];                                                // published_at desc, newsId desc; [] when selected === null
  liveSubject: string | null;                                     // 'n:topic:<code>' when a topic is selected, else null
  feedHealth: TopPayload['feedHealth'];                           // same shape and rule as TOP (TERM-12)
  suppressed: { entitlement: number; kindFilter: number };
  asOf: string;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `topics` (`topic_id`, `code`, `name`, `kind`, `parent_topic_id`, `keywords`), `news_entity_links` (`entity_kind='topic'`, `method IN ('feed_topic','keyword','manual')`, `confidence ≥ 0.9`), `news_items` (headlines and the `count24h`/`count7d` aggregates), `instruments` / `issuers` (current, for `links[].display`), `provenance`, `licence_registry`, `ingest_runs` (`feedHealth`) |
| Data services (§1.4.2) | `data.news.topics()` (the tree), `data.news.search({ topic, kinds, limit })` (headlines for the rolled codes) |
| Read-through (`providers.ensure`) | `('bbg.rss', feed, { maxAgeMs: 60_000 })` for the feed behind the selected topic when that `feedHealth` line is not `live` and `usage !== 'export'`; `('fed.rss', 'press_all', { maxAgeMs: 300_000 })` for `FED`. None for keyword/theme topics and none for `FILINGS` (no `sec.atom` read-through kind). |
| Engines (`core/analytics`) | None. |
| Subjects (live) | `n:topic:<code>` for the selected topic (`null` in the browser) |
| Field ids (`fieldIds(assetClass)`) | `default: []` — `n:` subjects subscribe with `f: []` (API.md §6.1); entitlement pre-check over sources `['bbg.rss','sec.atom','fed.rss']`, `field_class='news'` |

#### Resolver
1. `tree = await data.news.topics()` → `NiTopicNode[]`. `linkMethods` per topic comes from the seeded mapping in `packages/server/src/news/entityLink.ts`:

   | Topic codes | Method | Source of the link |
   | --- | --- | --- |
   | `MARKETS` `ECO` `POLITICS` `TECH` `WEALTH` `INDUSTRIES` | `feed_topic` (confidence 1.0) | the Bloomberg RSS feed the item arrived on (`news_items.feed`) |
   | `FED` | `feed_topic` (1.0) | `fed.rss` `press_all` |
   | `FILINGS` | `feed_topic` (1.0) | `sec.atom` 8-K current filings |
   | `RATES` `FX` `AI` | `keyword` (0.9) | whole-word match of `topics.keywords` against `headline` (`entityLink.ts` is precision-first: whole words only, headline only, never the summary — NEWS-02) |
   | `EARNINGS` `CA` | — (empty) | no feed and no reliable keyword set in v1 |

2. `count24h` / `count7d` / `lastPublishedAt`: one grouped query over `news_entity_links` ⋈ `news_items` for `entity_kind='topic'` within the two windows ending at `ctx.asOf.validAt`. A topic with `linkMethods.length === 0` gets `count* = 0`, `lastPublishedAt = null`, `reason:'TOPIC_NO_SOURCE'` and `ctx.unavailable.add({ field:'topics.' + code, reason:'NO_SOURCE', detail:'TOPIC_NO_SOURCE: no feed and no keyword set maps to this topic in v1' })` — the node is still listed, greyed, so the absence is visible rather than invented.
3. No `params.topic` → `selected = null`, `rows = []`, `liveSubject = null`; return after step 7 (the browser is the whole screen).
4. `params.topic` uppercased, matched on `topics.code`. No match → `ctx.unavailable.add({ field:'topic', reason:'NOT_APPLICABLE', detail:'UNKNOWN_TOPIC: <code>' })`, `selected = null` (the browser renders with the notice). `selected.reason === 'TOPIC_NO_SOURCE'` → `rows = []`, `liveSubject = 'n:topic:<code>'` is still returned (a future source would stream into it) and the screen shows the reason instead of an empty list.
5. `rolledCodes = includeChildren ? [code, ...descendants(code)] : [code]` (`topics.parent_topic_id`, depth ≤ 3).
6. `feedHealth` and the read-through for the selected topic's source exactly as TOP steps 2–3.
7. `rows = await data.news.search({ topic: rolledCodes, kinds: params.kinds, limit: params.limit + 20 })`, then the `kinds` filter (`suppressed.kindFilter`) and the licence filter with per-source access logging (`purpose:'NI'`, `suppressed.entitlement`) exactly as TOP step 5; truncate to `params.limit`; `provIdx` per row as TOP step 7; `machineGenerated` is `false` on every row (NEWS-08).
8. Return. Budget: 3 DB round-trips (tree, counts, headlines) plus at most 1 provider call; first paint < 500 ms p95.

#### Live
`{ subjects: payload.liveSubject ? [payload.liveSubject] : [], fields: [], essential: payload.liveSubject ? [payload.liveSubject] : [] }`, or `null` when `selected === null`. `n:` is not conflated, so `packages/web/src/screens/NI/Screen.tsx` prepends one row per `delta`, flashes it (TERM-08), caps the list at `params.limit` and increments the selected node's `count24h` in `grid#topics` so the browser column stays consistent with the list. NEWS-03 budget: receipt → screen < 1 s.

#### Screen
```
┌ NI · News by Topic · FED · Federal Reserve                        40 headlines · 24h 12 · 7d 61 · 18:41:28 ┐
│ split col [0.28 | 0.72]                                                                                    │
│ grid#topics                          │ list#rows (newsList('rows', rows, { showFeed:true, showKind:true })) │
│  code   name              24h   7d   │  13:55  FED  ◆  Federal Reserve Board announces …                    │
│  MARKETS Markets           20   131  │  11:30  FED  ◆  Minutes of the Federal Open Market Committee …       │
│  ECO     Economics         14    96  │  09:02  FED  ◆  Speech by Governor … on the economic outlook         │
│ ▸FED     Federal Reserve   12    61  │                                                                      │
│  FILINGS Filings           40   240  │                                                                      │
│  EARNINGS Earnings          —     —  │  text#topicreason (when the selected topic has no source):            │
│  CA      Corporate actions  —     —  │   TOPIC_NO_SOURCE — no feed and no keyword set maps to this topic     │
│ badges#health  [fed.rss 18:12:40 live] [bbg.rss markets live] [sec.atom STALE 20m]                          │
│ footer sources: Federal Reserve press releases; Bloomberg RSS; SEC EDGAR 8-K Atom · asOf 2026-09-15T18:41:28Z│
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `NI · News by Topic · <selected.code> · <selected.name>` (`NI · News by Topic · browse` when `selected === null`); subtitle `<rows.length> headlines · 24h <count24h> · 7d <count7d> · <asOf time>`; `initialFocus:'topics'` when `selected === null`, `'rows'` otherwise. `grid#topics` columns: `code` (`fmt:'text'`, child rows indented two spaces under their parent), `name`, `count24h` and `count7d` (`fmt:'int'`, `—` when the node has `reason:'TOPIC_NO_SOURCE'`), `lastPublishedAt` (`fmt:'datetime'`, shown only when the panel is ≥ 100 cols). The selected row is marked `▸` and `tone:'highlight'`; sourceless nodes are `tone:'muted'` with the reason in the cell tooltip. `list#rows` is empty-but-explained in two cases: `TOPIC_NO_SOURCE` (text above) and a topic with a source but no headline in the window (`no headlines for <code> in the captured corpus`). Skeleton: the topic grid with thirteen muted rows and ten muted list rows. `meta.entitlement` denials render as a muted line above the list.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid (`grid#topics`) | `select-topic` | `ctx.setParams({ topic: row.code })` (usage `fn.param`) |
| `Shift+Enter` | grid | `select-topic-next` | `ctx.navigateNext('NI ' + row.code)` |
| `Enter` | list (`list#rows`) | `open-story` | `ctx.openUrl(row.url)` (link-out only) + `usage_events { kind:'search.select', code:'NI', details:{ newsId } }` |
| `Shift+Enter` | list | `open-security` | `ctx.navigateNext(row.links.find(l => l.entityKind === 'instrument')?.display + ' DES')` when linked |
| `Ctrl+I` | grid, list | reserved provenance | `ctx.provenance(row.provIdx)` for a headline; on a topic row, the provenance of the feed behind it (DATA-10) |
| `C` | always | `toggle-children` | `ctx.setParams({ includeChildren: !includeChildren })` |
| `K` | always | `cycle-kinds` | `ctx.setParams({ kinds })` cycling all → stories → filings |
| `+` / `-` | always | `more` / `fewer` | `ctx.setParams({ limit: clamp(limit ± 20, 10, 100) })` |
| `A` | always | `alert-on-topic` | `sdk.alerts.create({ condition: { kind:'news', query: { topic: selected?.code } } })` (NEWS-07); no selection → `notice` |
| `N` | always | `open-n` | `ctx.navigate('N TOPIC=' + (selected?.code ?? ''))` — the same topic in the searchable reader |
| `T` | always | `open-top` | `ctx.navigate('TOP ' + (selected?.code ?? ''))` |
| `Home` / `End` | grid | `first-topic` / `last-topic` | move the grid cursor |

#### CSV
`filename = 'NI_' + (selected?.code ?? 'BROWSE') + '_' + asOfCompact + '.csv'`. Multi-block long format (§1.6 rule 3): a leading `section` column over the union of both blocks' columns. `section:'topic'` rows use `code,name,kind,parentCode,linkMethods,count24h,count7d,lastPublishedAt,reason` (one row per `topics[]`, in tree order); `section:'news'` rows use `newsCsvColumns` (§0.5) with `newsCsvRow(r)` (one row per `rows[]`). Columns are therefore payload-independent and static: `section` + the nine topic columns + the nine news columns, with the block that does not own a column left empty. Export licence filtering and the `# suppressed` comment are as TOP; the topic block is never suppressed (counts are ours, not the publisher's). Examples: `topic,FED,Federal Reserve,feed,,feed_topic,12,61,2026-09-15T17:55:00Z,,,,,,,,,` and `news,,,,,,,,,2026-09-15T17:55:00Z,fed.rss,press_all,fed_release,Federal Reserve Board announces …,https://www.federalreserve.gov/newsevents/pressreleases/…,FED,false,1203`.

#### Help
summary `Browse the topic tree and read the headline feed for one topic`; description `NI is the topic browser: every topic the platform links headlines to, with how many arrived in the last 24 hours and 7 days, and the headline list for the topic you select. Topics reach headlines two ways — a feed mapping, where every item from a publisher feed belongs to the topic, and a keyword match on the headline, which is deliberately narrow so a topic never collects stories it does not own. Topics that have neither are listed greyed with the reason rather than shown empty: nothing on this screen is inferred. Selecting a topic streams new headlines into the list as they arrive. Press N to search inside the topic, T for the ranked view, A to be alerted on the next headline.`; params `topic` ("topic code", `FED`), `limit` ("10–100 headlines", `N=100`), `kinds` ("item kinds, repeatable", `KIND=FILING`), `includeChildren` ("roll child topics into the list", `CHILDREN=N`); sources `['bbg.rss','sec.atom','fed.rss']`; related `['TOP','N','CN','ECO','FED']`.

#### Unavailable and reason codes
`{ field:'topic', reason:'NOT_APPLICABLE', detail:'UNKNOWN_TOPIC: <code>' }` (browser renders, no selection); `{ field:'topics.<code>', reason:'NO_SOURCE', detail:'TOPIC_NO_SOURCE: no feed and no keyword set maps to this topic in v1' }` — always emitted for `EARNINGS` and `CA` in v1, and the node carries `reason:'TOPIC_NO_SOURCE'` (footer code `TOPIC_NO_SOURCE`); `{ field:'rows', reason:'NO_SOURCE', detail:'NO_HEADLINES_IN_CORPUS: <code> has a source but no captured headline in the window' }`; `{ field:'feedHealth.<sourceId>', reason:'NO_SOURCE', detail:'PROVIDER_DOWN: serving stored headlines' }`; `{ field:'feedHealth.sec.atom', reason:'NO_SOURCE', detail:'NO_READ_THROUGH_SEC_ATOM: 8-K headlines refresh only on the scheduler tick' }` (so `NI FILINGS` can be up to one scheduler interval behind and says so); `{ field:'rows[].summary', reason:'NOT_LICENSED', detail:'NO_BODY_LICENCE: headline, summary and link only' }` for `bbg.rss` rows. Entitlement: per-source `NO_FIRM_ENTITLEMENT` with the count in `suppressed.entitlement`; export-side `NOT_LICENSED_EXPORT` as a CSV header comment; `TIER_EOD` never applies to `field_class:'news'` (ENTL-05).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/NI.golden.test.ts` | `NI FED` at the frozen clock deep-equals `NI.default.json` from `fed-press-rss.xml` + the five `bbg-rss-*` + `sec-8k-atom.xml`: `selected.code === 'FED'`, `selected.linkMethods === ['feed_topic']`, every row `sourceId === 'fed.rss'`, rows strictly descending by `(publishedAt, newsId)`, `topics` contains all thirteen seeded codes in tree order, the `EARNINGS` and `CA` nodes have `linkMethods: []`, `count24h === 0` and `reason === 'TOPIC_NO_SOURCE'`, and `meta.unavailable` carries the two matching `TOPIC_NO_SOURCE` entries |
| resolver unit | `packages/server/test/unit/functions/NI.topics.test.ts` | `includeChildren` rolls descendants to depth 3 into `rolledCodes` and no further; `NI` with no topic returns `selected === null`, `rows === []`, `liveSubject === null` and a fully populated tree; `NI ZZZ` returns the `UNKNOWN_TOPIC` entry and still renders the tree |
| entity linking | `packages/server/test/unit/news/entityLink.test.ts` | `feed_topic` links every `bbg-rss-markets` item to `MARKETS` at confidence 1.0; the `keyword` method links only on whole words in the headline (`"rates"` links `RATES`, `"generates"` does not) and never from the summary; no link below 0.9 is written (NEWS-02) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(NI golden))` equals `NI.default.csv`; both `section` blocks present; the topic block's `count24h` equals `topics[i].count24h`; the news block's columns equal `newsCsvColumns` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | `rows[0]` equals the `n:topic:FED` WS `snap` values at the frozen clock (API-05) |
| screen | `packages/web/test/screens/NI.test.tsx` | renders the golden; `Enter` on a topic row calls `setParams({ topic })`; a sourceless node renders muted with `—` counts and the `TOPIC_NO_SOURCE` text instead of an empty list; an `n:topic:FED` delta prepends, flashes and increments `count24h`; `C`/`K`/`+`/`-` call `setParams`; skeleton |
| e2e | `packages/e2e/tests/news.spec.ts` | closing the morning flow: `NI <GO>` paints the topic tree; `Enter` on `FED` loads its headlines and the URL-visible params change; the replayed `fed.rss` headline appears at the top within 1 s (NEWS-03); `NI CA <GO>` shows the greyed `TOPIC_NO_SOURCE` panel with no fabricated rows |

---

---

### MSG — Messaging

| Attribute | Value |
| --- | --- |
| Code / aliases | `MSG` / `IB` (`aliasParams` `{ IB: { view: 'rooms' } }`), `CHAT` |
| Tier / category | 1 / messaging |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/MSG.ts` · `packages/server/src/functions/MSG/resolve.ts` · `packages/web/src/screens/MSG/Screen.tsx` · `packages/web/src/screens/MSG/Composer.tsx` · `fixtures/golden/functions/MSG.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (MSG-01) (MSG-02) (MSG-03) (MSG-04) (MSG-06) (SEC-06) (REG-01) (REG-04) (TERM-03) (TERM-06) (TERM-08) (TERM-09) (TERM-12) (BUS-01) (BUS-02) (BUS-06) (DATA-10) (ENTL-04) (ENTL-05) (OPS-07) |

MSG-05 (federation to Symphony / Teams / ICE Chat) is a declared v1 non-goal (BRIEF §1); the screen states
it in the policy strip rather than offering a disabled control.

#### Params
```ts
export const MsgParams = z.object({
  roomId: z.number().int().positive().nullable().default(null),   // the room to open; null → the most recently active room the caller is a member of
  to: z.string().max(80).nullable().default(null),                // directory query: 'MSG jane.doe' opens (or creates on send) the dm with the single best match
  view: z.enum(['split', 'rooms', 'room', 'directory']).default('split'),
  limit: z.number().int().min(20).max(200).default(50),           // messages per page, newest-first window
  filter: z.string().max(80).default(''),                         // room-list substring filter over room name and member display names
  unreadOnly: z.boolean().default(false),
});
```
#### Argument grammar
`positional [{ name:'to', type:'string', optional:true }]`, `keyed { ROOM: { name:'roomId', type:'int' }, VIEW: { name:'view', type:'enum', values:['split','rooms','room','directory'] }, N: { name:'limit', type:'int' }, FILTER: { name:'filter', type:'string' }, UNREAD: { name:'unreadOnly', type:'boolean' } }`, no `rest`.
Examples: `MSG` → `{ roomId:null, to:null, view:'split', limit:50, filter:'', unreadOnly:false }` · `MSG jane.doe` → `{ to:'jane.doe' }` · `MSG ROOM=7 N=200 VIEW=ROOM` → `{ roomId:7, limit:200, view:'room' }`.
`IB` (the alias) launches with `{ view:'rooms' }` merged before the zod parse (runner step 1, FUNCTIONS.md §1.4.3); `IB ROOM=7` → `{ view:'rooms', roomId:7 }`.

#### Payload
```ts
export type MsgView = 'split' | 'rooms' | 'room' | 'directory';
export type MsgRoomKind = 'dm' | 'group' | 'firm' | 'helpdesk';
export type MsgSendBlock = 'OK' | 'MESSAGE_POLICY_BLOCKED' | 'ETHICAL_WALL' | 'EXTERNAL_NOT_PERMITTED' | 'NOT_A_MEMBER';
export type MsgAttachKind = 'security' | 'function' | 'chart' | 'portfolio' | 'watchlist';

/** MSG-04: one shared object as THIS viewer may see it. Live numbers are ValueCells under the viewer's own entitlements. */
export interface MsgAttachmentView {
  idx: number;                                   // position within the message's attachments[]
  kind: MsgAttachKind;
  label: string;                                 // 'AAPL US Equity' | 'GP · AAPL US Equity · 1Y' | 'Core' | 'Demo Fund I'
  command: string | null;                        // what GO runs for the viewer ('AAPL US Equity GP 1Y'); null when not resolvable
  instrumentId: number | null;                   // security / chart / structured
  code: string | null;                           // function / chart attachments: 'GP'
  params: Record<string, unknown>;               // function / chart attachments, verbatim from the sender
  resultId: string | null;                       // sender's cached result; re-run at the cached asOf under the viewer's entitlements
  portfolioId: number | null; watchlistId: number | null; annotationIds: number[];
  subject: string | null;                        // 'q:42' when a live price is shown next to the chip
  px: ValueCell | null; chgPct: ValueCell | null;
  resolvable: boolean;
  reason: 'OK' | 'NOT_ENTITLED' | 'NOT_IN_UNIVERSE' | 'NOT_SHARED_WITH_YOU' | 'RESULT_EXPIRED' | 'FUNCTION_NOT_FOUND';
}

export interface MsgStructuredView {              // MSG-06: display only, never an order (BRIEF §1 EXEC-* out of scope)
  type: 'ioi' | 'rfq'; side: 'buy' | 'sell';
  instrumentId: number; display: string;          // 'AAPL US Equity'
  qty: number; price: number | null;
  px: ValueCell | null;                           // live PX_LAST for context, viewer's entitlements
  subject: string | null;
}

export interface MsgMessageRow {
  messageId: number; roomId: number; seq: number;
  senderUserId: number; senderFirmId: number; senderDisplay: string; senderFirmName: string; senderDesk: string | null;
  isOwn: boolean; sentAt: string;                 // ISO-8601 UTC
  body: string;                                   // stored text, never rewritten (messages are immutable, API.md §5.10)
  attachments: MsgAttachmentView[];
  structured: MsgStructuredView | null;
  clientMsgId: string; prevHash: string | null; hash: string;     // sha256 hex, messages_chain trigger (MSG-02)
  chainOk: boolean;                               // recomputed over the returned window; false ⇒ archive integrity warning
  unread: boolean;                                // seq > message_reads.last_read_seq for the caller
}

export interface MsgMemberView {
  userId: number; displayName: string; firmId: number; firmName: string; desk: string | null;
  role: 'member' | 'owner' | 'supervisor'; verified: boolean; isSelf: boolean;
}

export interface MsgRoomRow {
  roomId: number; kind: MsgRoomKind; name: string;                // dm rooms: the counterparty display name
  scope: 'internal' | 'external'; firmId: number | null;
  wallTag: string | null; disclaimer: string | null; retentionDays: number; createdAt: string;
  members: MsgMemberView[];
  lastSeq: number; lastReadSeq: number; unread: number;
  lastMessageAt: string | null; lastMessagePreview: string | null;  // first 80 chars of the last body, attachments rendered as '[GP AAPL US Equity]'
  subject: string;                                 // 'room:<roomId>'
}

export type MsgPayload = {
  variant: 'default';
  view: MsgView;
  me: { userId: number; displayName: string; firmId: number; firmName: string; desk: string | null;
        role: 'user' | 'admin' | 'compliance' | 'dataops' | 'helpdesk' | 'newsroom' };
  rooms: MsgRoomRow[];                             // filtered by params.filter / params.unreadOnly, most recent activity first
  active: {
    room: MsgRoomRow;
    messages: MsgMessageRow[];                     // ascending seq, the window ending at room.lastSeq (or at the page cursor)
    canSend: boolean; sendBlockedReason: MsgSendBlock;
    olderCursor: string | null; newerCursor: string | null;
  } | null;
  directory: Array<MsgMemberView & { canMessage: boolean; blockedReason: MsgSendBlock }>;   // MSG-01, populated for view 'directory' or when params.to is set
  policy: {                                        // MSG-03, from firms.policy and rooms.*
    firmName: string; retentionDays: number; disclaimer: string | null;
    permittedCounterpartyFirms: string[]; ethicalWalls: Array<{ deskA: string; deskB: string }>;
    archived: true; surveillance: true;            // constants: every message is WORM-archived and lexicon-scanned (MSG-02)
    legalHoldActive: boolean;                      // any open legal_holds row whose scope covers the caller or the active room
    federation: 'NOT_IN_SCOPE_V1';                 // MSG-05
  };
  totals: { rooms: number; unread: number; directoryMatches: number };
};
```
Presence is absent by design: no v1 source publishes it (see "Unavailable and reason codes"), so
`MsgMemberView` carries no online flag rather than a fabricated one (FUNCTIONS.md §1.3 rule 6).

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md §13) | `rooms`, `room_members`, `messages`, `message_reads`, `legal_holds`, `firms` (`policy`, `retention_days`, `name`), `users` (`display_name`, `desk`, `role`, `status`, `person_verified_at`, `anonymised_at`), `instruments` (attachment display keys), `watchlists`, `portfolios`, `chart_annotations`; read through RLS with `app_user_id()`/`app_firm_id()` and `is_room_member()` (SEC-05, PORT-07) |
| Data services | `data.messaging.rooms()`, `data.messaging.messages(roomId, { cursor, limit })`, `data.messaging.directory(q)`, `data.reference.instrument(id)` (attachment display keys), `data.workspace.watchlist(id)`, `data.portfolio.get(id)`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through | None. Messaging content is first-party (`internal.user`); attachment prices follow §0.4 rule 2 — the resolver never calls `providers.ensure`, it calls `plant.ensureHot` and lets the scheduler poll. |
| Engines | None. |
| Subjects (live) | `room:<roomId>` for the active room **and** every room in `rooms[]` (unread counters); `q:<instrumentId>` for each distinct attachment/structured instrument |
| Field ids | `default: [PX_LAST, CHG_NET_1D, CHG_PCT_1D, LAST_TRADE_TIME]` — the entitlement pre-check set for attachment cells only; message bodies are not dictionary fields and are not entitlement-evaluated |

#### Resolver
1. `me` from `ctx.user` joined to `users`/`firms` (`display_name`, `desk`, `role`, `firms.name`, `firms.retention_days`, `firms.policy`). A caller whose `users.status ≠ 'active'` never reaches here (the session is revoked); a caller with `anonymised_at` set renders as `user-<id>` everywhere (REG-04).
2. `rooms = await data.messaging.rooms()` — rooms where `room_members.user_id = ctx.user.userId AND left_at IS NULL`, RLS-scoped. Map each to `MsgRoomRow`: `name` = `rooms.name`, or for `kind:'dm'` the other member's `display_name`; `unread = lastSeq − lastReadSeq` (clamped at 0); `subject = 'room:' + roomId`. Apply `params.filter` (case-insensitive substring over `name` and member display names) and `params.unreadOnly`; sort by `lastMessageAt` desc, `roomId` desc; `totals.rooms` is the count **before** filtering.
3. Active room selection: `params.roomId` when the caller is a member (else `422 NOT_A_MEMBER` is not raised — the payload sets `active = null` and `ctx.unavailable.add({ field:'active', reason:'NOT_APPLICABLE', detail:'ROOM_NOT_A_MEMBER: you are not a member of room <id>' })`, because MSG has no security context to fail on); otherwise `params.to` resolves through step 4; otherwise `rooms[0]`; otherwise `null`.
4. `params.to` (MSG-01): `dir = await data.messaging.directory(params.to)` (verified, non-deprovisioned users, ranked by exact email → display-name prefix → desk). `directory[]` is populated with `canMessage` per step 8. When exactly one match exists and a `dm` room with exactly `{me, match}` already exists, that room becomes active; when none exists the room is **not** created by the resolver (`POST /rooms` happens on first send from the composer) and `active = null` with `view` forced to `'directory'`.
5. Messages: `data.messaging.messages(roomId, { cursor: ctx.page?.cursor ?? null, limit: params.limit })` → `messages` table window, ascending `seq`. Without a cursor the window is the newest `limit` rows (`seq > lastSeq − limit`). `ctx.page.set({ index, count: Math.ceil(room.lastSeq / params.limit), cursor: olderCursor })`.
6. Chain verification (MSG-02): for each returned row recompute `sha256(prev_hash || room_id || seq || sender || sent_at || body || attachments)` and compare with `hash`; the first mismatch sets `chainOk:false` on that row and every later row of the window and raises `ctx.unavailable.add({ field:'active.messages', reason:'NOT_APPLICABLE', detail:'ARCHIVE_CHAIN_BROKEN: hash chain breaks at seq <n>; produce the room through /admin/export/messages' })`. Verification is O(window), never O(room).
7. Attachments (MSG-04), per message, per attachment, in order:
   - `security` → `data.reference.instrument(instrumentId)`; `label` = `display` (`'AAPL US Equity'`), `command` = `label + ' DES'`, `subject = plant.subjectFor(instrumentId)`.
   - `chart` → same instrument lookup; `label = 'GP · ' + display + (params.range ? ' · ' + params.range : '')`, `command = display + ' GP' + argString(params)`, `annotationIds` kept (the screen resolves the shared annotations through `/annotations`; ids the viewer may not read are dropped by RLS and the chip shows `(n shared annotations)`).
   - `function` → `registry.canonical(code)`; `label = code + (instrumentId ? ' · ' + display : '')`, `command = (display ? display + ' ' : '') + code + argString(params)`; unknown code → `resolvable:false`, `reason:'FUNCTION_NOT_FOUND'`.
   - `portfolio` / `watchlist` → `data.portfolio.get` / `data.workspace.watchlist`; RLS returning nothing → `resolvable:false`, `reason:'NOT_SHARED_WITH_YOU'`, `label = kind + ' #' + id` and `command = null`.
   - `resultId` present → kept verbatim; the **screen** (not the resolver) calls `GET /results/:resultId`, which re-runs at the cached `asOf` under the viewer's entitlements (FUNCTIONS.md §1.4.3); an expired result renders `reason:'RESULT_EXPIRED'` and falls back to `command`.
8. Policy (MSG-03), evaluated once for the active room and once per directory entry by `packages/server/src/messaging/service.ts#canMessage(me, counterparty, room)`: (a) `rooms.scope='external'` or a counterparty in another firm requires that firm's name to be in `firms.policy.permittedCounterpartyFirms` → else `EXTERNAL_NOT_PERMITTED`/`MESSAGE_POLICY_BLOCKED`; (b) `rooms.wall_tag` non-null requires every member's `users.desk` to carry that tag, and `firms.policy.ethicalWalls[{deskA,deskB}]` blocks any pair of desks listed → `ETHICAL_WALL`; the `newsroom` role is walled from every non-`newsroom` desk unconditionally (SEC-06); (c) non-membership → `NOT_A_MEMBER`. `canSend = sendBlockedReason === 'OK'`.
9. `policy.legalHoldActive` = `EXISTS (SELECT 1 FROM legal_holds WHERE firm_id = me.firmId AND released_at IS NULL AND (scope->'userIds' @> me.userId OR scope->'roomIds' @> activeRoomId))`. `policy.retentionDays = max(firms.retention_days, rooms.retention_days)` for the active room, `firms.retention_days` otherwise (REG-01 floor: 7 years, never lowered by the room).
10. Live cells: `subjects = distinct attachment/structured instrument subjects`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`; `px = cellFromState(ctx, states.get(subject), 'PX_LAST', subject)` and `chgPct = cellFromState(ctx, …, 'CHG_PCT_1D', subject)` (§0.4 rules 1 and 2 — never `providers.ensure`, so a shared name with no recorded quote is simply pending). A field the viewer is not entitled to arrives already nulled with `r` set (ENTL-05).
11. Return `{ variant:'default', view: params.view, me, rooms, active, directory, policy, totals }`.
Budget: 3 DB round-trips (rooms+members+reads in one query, the message window in one, the attachment reference/watchlist/portfolio lookups batched in one) plus plant reads; zero provider calls; first paint < 500 ms p95, < 120 ms p95 hot with the seeded two rooms.

#### Live
```ts
live: (params, payload) => ({
  subjects: [...payload.rooms.map(r => r.subject),
             ...distinct(payload.active?.messages.flatMap(m =>
                 [...m.attachments.map(a => a.subject), m.structured?.subject ?? null]).filter(Boolean) ?? [])],
  fields: ['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D', 'LAST_TRADE_TIME'],
  conflationMs: 250,
  essential: payload.active ? [payload.active.room.subject] : [],
})
```
`room:<id>` carries no fields: `packages/web/src/state/subscriptions.ts` intersects `LiveSpec.fields` with the subject family and sends `f: []` for the `room:` family (§0.4 rule 5, API.md §6.1). A `msg { room, message }` frame for the **active** room appends a `MsgMessageRow` to `active.messages` (validated with `Rest.Messages.Message`, attachments resolved client-side exactly as resolver step 7, then `POST /rooms/:roomId/read` when the list is scrolled to the bottom); a frame for any other room increments that room's `unread` and re-sorts `grid#rooms`. Attachment chips register `Cell.live = { subject:'q:<id>', field:'PX_LAST' }` so they flash like any monitor cell (TERM-08) and go stale on the same 1 s ticker (TERM-12). `subAck` rejecting `room:<id>` with `NOT_ENTITLED` (membership revoked mid-session) turns that row muted with the badge `NOT_A_MEMBER` and drops it on the next run.

#### Screen
Title `MSG · Messaging · <me.displayName> @ <me.firmName>` (alias launch: `IB · Instant Bloomberg · …`); subtitle `<totals.rooms> rooms · <totals.unread> unread · archived · retention <policy.retentionDays> d<legal hold ? ' · LEGAL HOLD' : ''>`; `initialFocus:'composer'` for `view` `split`/`room`, `'rooms'` for `rooms`, `'directory'` for `directory`.
Body for `view:'split'` — `split row [0.28 | 0.72]`:
```
┌ MSG · Messaging · Alex Pardo @ Demo Capital            2 rooms · 3 unread · archived · retention 2555 d ┐
│ grid#rooms                        │ badges#policy [firm room · internal · surveillance on] [disclaimer]  │
│ room | kind | last | unread       │ list#messages (live room:1)                                          │
│ Demo Capital  firm  18:39  2      │ 18:31:02 Jane Ruiz (Demo Capital · Equities PM)                      │
│ Jane Ruiz     dm    18:41  1      │   morning — flagging the print on the open                           │
│ ────────────────────────────────  │ 18:39:44 Alex Pardo (you)                                            │
│ text#directory-hint               │   [AAPL US Equity  330.27 ▾ −0.84%]  [GP · AAPL US Equity · 1Y]      │
│  Alt+D directory · Alt+N new room │ 18:41:10 Jane Ruiz  [IOI buy AAPL US Equity 25,000 @ 330.00]         │
│                                   │ ──────────────────────────────────────────────────────────────────── │
│                                   │ custom#composer (Composer)  ▸ type · Alt+S security · Alt+F function │
│                                   │   Messages are archived and monitored. Sending to Demo Capital only. │
└ footer sources: Terminal messaging (internal, WORM-archived); Cboe delayed quotes (attachment prices)    ┘
```
`view:'rooms'` (the `IB` landing) drops the split and renders `grid#rooms` full width with the columns
`room | kind | scope | members | last message | last | unread`, `rows[].command = 'MSG ROOM=' + roomId`,
`emptyText: 'No rooms — Alt+N to start one'`, plus `list#messages` collapsed to a 3-line preview of the
selected row. `view:'room'` drops `grid#rooms`. `view:'directory'` replaces the right pane with
`grid#directory` (`name | firm | desk | role | verified | can message`), `emptyText: 'No verified user matches "<filter>"'`.
Formats: `sentAt` `datetime` in the viewer's browser tz with the UTC ISO in the title attribute; `unread`
`int`; attachment `px` `fmt:'px'` with `decimals` from `instruments.price_decimals` via `core/fields/format.ts`;
`chgPct` `fmt:'pct'` `decimals:2` with `dir` from its sign; `retentionDays` `int`; `hash` `text`, truncated
to the first 12 hex characters in the list and shown in full in the provenance panel.
Skeleton (`payload === undefined`): `grid#rooms` with 3 muted rows, `list#messages` with 5 muted lines,
`custom#composer` disabled with the placeholder `loading…`.
`meta.entitlement` renders inside attachment chips only: a denied `PX_LAST` is `—` with the reason
(`TIER_EOD`, `NO_FIRM_ENTITLEMENT`) in the tooltip; the chip's label and `command` stay live, so the
recipient can still open the function and hit the same denial with the same reason (ENTL-05).
`meta.unavailable` entries render as `badges#policy` items with tone `warn` (`ARCHIVE_CHAIN_BROKEN` is
tone `error`), and `PRESENCE_NOT_AVAILABLE` as a muted `text` line under `grid#rooms`.
The `custom#composer` node is `{ kind:'custom', id:'composer', component:'Composer', props: { roomId, canSend, sendBlockedReason, disclaimer, draftKey: 'msg:<panelId>:<roomId>', maxLength: 8000, attachments: PendingAttachment[] } }`; it owns printable keys while focused (§2.6 `Ctrl+L` note) and posts `POST /rooms/:roomId/messages { clientMsgId: uuid(), body, attachments, structured }`, retrying the same `clientMsgId` on network failure (idempotent, API.md §5.10).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid (`grid#rooms`) | `open-room` | `ctx.setParams({ roomId: row.instrumentId === undefined ? Number(row.id) : Number(row.id), view: 'split' })` (`row.id` is the `roomId`) |
| `Shift+Enter` | grid (`grid#rooms`) | `open-room-next` | `ctx.navigateNext('MSG ROOM=' + row.id)` |
| `Enter` | list (`list#messages`) | `open-attachment` | runs the focused message's first `resolvable` attachment `command`; no attachment → no-op |
| `Shift+Enter` | list (`list#messages`) | `open-attachment-next` | same command in the next panel |
| `Enter` | grid (`grid#directory`) | `open-dm` | `ctx.setParams({ to: row.id, view: 'split' })` |
| `Enter` | form (`custom#composer`) | `send` | sends the draft (the composer owns `Enter` while focused; `Shift+Enter` inserts a newline) |
| `Alt+D` | always | `open-directory` | `ctx.setParams({ view: 'directory' })` (usage `fn.param`) |
| `Alt+R` | always | `cycle-view` | `ctx.setParams({ view: next of split→rooms→room→directory })` |
| `Alt+U` | always | `toggle-unread` | `ctx.setParams({ unreadOnly: !unreadOnly })` |
| `Alt+N` | always | `new-room` | `ctx.prompt('text', { label: 'Members (comma-separated)' })` → `POST /rooms { kind, memberUserIds }` → `setParams({ roomId })`; `403 MESSAGE_POLICY_BLOCKED` renders the reason in the footer |
| `Alt+M` | always | `mark-read` | `POST /rooms/:roomId/read { lastReadSeq: active.room.lastSeq }`, then clears `unread` |
| `Alt+S` | form (`custom#composer`) | `attach-security` | `ctx.prompt('security')` → pending `{ kind:'security', instrumentId }` |
| `Alt+F` | form (`custom#composer`) | `attach-function` | attaches the focused panel's last result: `{ kind:'function', code, instrumentId, params, resultId }` (MSG-04) |
| `Alt+W` | form (`custom#composer`) | `attach-watchlist` | `ctx.prompt('watchlist')` → pending `{ kind:'watchlist', watchlistId }` |
| `Alt+H` | list (`list#messages`) | `show-hash` | opens the archive detail for the focused message: `seq`, `sentAt`, `prevHash`, `hash`, `chainOk` (MSG-02; `Ctrl+I` stays the reserved provenance key and applies to attachment cells) |
| `Ctrl+ArrowUp` / `Ctrl+ArrowDown` | always | `prev-room` / `next-room` | move one row in `grid#rooms` and open it |
| `PageDown` / `PageUp` | list (`list#messages`) | reserved (PAGE FWD / BACK) | older / newer history page (`pageable`, below) |
| `Ctrl+P` | always | reserved (PRINT) | CSV transcript of the active room (below) |

#### CSV
`pageable:true` — the cursor is `base64url(JSON.stringify({ roomId, seq }))` of the window's edge message.
**PAGE FWD means older** (`seq < cursor.seq`, the natural direction for chat history); PAGE BACK returns
toward `room.lastSeq`. `meta.page = { index, count: ceil(room.lastSeq / limit), cursor: olderCursor }`.

`filename = active ? 'MSG_room' + active.room.roomId + '_' + asOfCompact + '.csv' : 'MSG_rooms_' + asOfCompact + '.csv'`
(`asOfCompact` = `meta.asOf.validAt` without `-`/`:`, e.g. `20260915T184128Z`).
Long-format with a leading `section` column (FUNCTIONS.md §1.6 rule 3); static columns:
```ts
export const msgCsvColumns: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },      // 'policy' | 'room' | 'member' | 'message' | 'attachment'
  { id: 'roomId', label: 'Room id', type: 'number' }, { id: 'seq', label: 'Seq', type: 'number' },
  { id: 'ts', label: 'Timestamp', type: 'datetime' }, { id: 'sender', label: 'Sender', type: 'string' },
  { id: 'senderFirm', label: 'Sender firm', type: 'string' }, { id: 'desk', label: 'Desk', type: 'string' },
  { id: 'body', label: 'Body', type: 'string' }, { id: 'detail', label: 'Detail', type: 'string' },
  { id: 'hash', label: 'Hash', type: 'string' }, { id: 'chainOk', label: 'Chain ok', type: 'boolean' },
];
```
Rows, in this order: one `policy` row (`detail` = `retention=<n>d; disclaimer=<text>; counterparties=<a|b>; walls=<deskA/deskB>; legalHold=<bool>; surveillance=true; federation=NOT_IN_SCOPE_V1`); one `room` row per `rooms[]` (`body` = `name`, `detail` = `kind/scope/unread`); one `member` row per member of the active room (`sender` = display name, `detail` = `role`); one `message` row per `active.messages[]`; one `attachment` row per attachment (`body` = `label`, `detail` = `kind|command|reason`, `seq` = the parent message's seq). When `active === null` only the `policy` and `room` sections are written. Blank cells are `null`, not `''`.
Example: `message,1,6,2026-09-15T18:39:44Z,Alex Pardo,Demo Capital,Equities PM,"flagging the print on the open",,9f2c1b0a…,true`.
`Ctrl+E` on `grid#rooms` exports the room list alone through `/data/csv`. Exporting a transcript writes a
`fn.export` usage event and an `access_log` row with `purpose:'MSG'` and `usage:'export'` (ENTL-04, FUNC-04);
the regulatory production path stays `GET /admin/export/messages` (NDJSON with the chain verdict, REG-01).

#### Help
summary `Chat rooms and direct messages with live shared securities, charts and functions`;
description `MSG is the terminal's messaging screen: your rooms on the left, the open conversation on the right, a composer at the bottom. IB and CHAT are the same screen; IB opens on the room list. Rooms are direct messages, group rooms, your firm room or a helpdesk room opened by a HELP ticket. Anything you attach — a security, a chart, a function result, a watchlist or a portfolio — arrives as a chip the recipient can open with GO, and any price on it is resolved against the recipient's own entitlements, not yours: if they are entitled to end-of-day only, they see an end-of-day number with the reason, never yours. Every message is written once to a hash-chained archive that the screen verifies as it loads, is scanned against the compliance lexicon and is kept for at least your firm's retention period; the screen tells you so on every room and names the ethical walls and permitted counterparty firms that apply. Structured IOI and RFQ messages are displayed as they were sent and are never orders — this terminal does not execute. There is no presence indicator and no federation to outside networks in this version.`;
params `roomId` ("room to open", `ROOM=7`), `to` ("open a direct message with a directory match", `MSG jane.doe`), `view` ("split, rooms, room or directory", `VIEW=ROOMS`), `limit` ("messages per page 20–200", `N=200`), `filter` ("filter the room list", `FILTER=demo`), `unreadOnly` ("only rooms with unread messages", `UNREAD=Y`);
sources `['internal.user', 'cboe.quotes', 'yahoo.chart']`; related `['HELP', 'DES', 'GP', 'W', 'PORT']`.

#### Unavailable and reason codes
| `field` | `reason` | `detail` (footer code first) |
| --- | --- | --- |
| `members[].presence` | `NO_SOURCE` | `PRESENCE_NOT_AVAILABLE: no presence service in v1; the room list shows last message time instead of who is online` |
| `federation` | `NOT_APPLICABLE` | `FEDERATION_NOT_IN_SCOPE_V1: MSG-05 (Symphony, Teams, ICE Chat) is an explicit v1 non-goal (BRIEF §1)` |
| `active` | `NOT_APPLICABLE` | `ROOM_NOT_A_MEMBER: you are not a member of room <id>` (also emitted when `rooms` is empty: `NO_ROOMS: you are not a member of any room — Alt+N to start one`) |
| `active.messages` | `NOT_APPLICABLE` | `ARCHIVE_CHAIN_BROKEN: hash chain breaks at seq <n>; produce the room through /admin/export/messages` |
| `active.canSend` | `NOT_APPLICABLE` | `MESSAGE_POLICY_BLOCKED: <firm> is not a permitted counterparty` / `ETHICAL_WALL: <deskA> and <deskB> are walled` / `EXTERNAL_NOT_PERMITTED: this room is external and your firm policy does not allow it` (MSG-03, SEC-06) |
| `attachments[<i>]` | `NOT_LICENSED` | `ATTACHMENT_NOT_ENTITLED: you are not entitled to <instrument>; the chip opens but the price is blank` |
| `attachments[<i>]` | `NOT_APPLICABLE` | `ATTACHMENT_NOT_SHARED: the sender's portfolio/watchlist is not shared with you` · `RESULT_EXPIRED: the shared result is older than 10 minutes; open the function instead` · `FUNCTION_NOT_FOUND: <code> is not in this registry version` |
| `structured` | `NOT_APPLICABLE` | `IOI_DISPLAY_ONLY: structured messages are displayed, never routed — execution is out of scope (MSG-06, BRIEF §1)` |
Per-cell entitlement denials on `px`/`chgPct` come from `meta.entitlement` with the standard codes
(`TIER_EOD`, `NO_FIRM_ENTITLEMENT`, `NOT_ENTITLED_TIER`, `SOURCE_TIER_CAP`). `PROVIDER_DOWN` leaves
attachment cells `st:'stale'` with their last values and never blanks them (TERM-12). A room whose
retention has elapsed is not purged below `firms.retention_days` (REG-01): the purge job cannot produce a
partial room, so there is no "partially retained" state to render.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2; `aliases` `['IB','CHAT']` unique across the registry, `aliasParams` keys ⊆ `aliases`, `assetClasses:'none'` ⇒ `variants:{}` and `requiresSecurity:false` |
| golden payload | `packages/server/test/integration/functions/MSG.golden.test.ts` | `MSG` as `pm@demo` (userId 2, firmId 1) at the frozen clock `2026-09-15T18:41:28Z` deep-equals `fixtures/golden/functions/MSG.default.json`: `rooms.length === 2` (the `Demo Capital` firm room and the seeded dm), `totals.unread` matches `message_reads`, `active.messages.length === 6`, every `chainOk === true`, the `AAPL US Equity` attachment has `px.v === 330.27` and `px.live.subject === 'q:42'`, `policy.retentionDays === 2555`, `policy.federation === 'NOT_IN_SCOPE_V1'` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `MSG.default.csv`; the `policy`, `room`, `member`, `message` and `attachment` sections each have 11 cells per row; `hash` cells equal the payload `hash` values |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV at the frozen `asOf`; attachment `px.v` equals the WS `snap.f.PX_LAST` for `q:42` (API-05) |
| hash chain | `packages/server/test/integration/messaging/chain.test.ts` | `messages_chain` trigger assigns `seq` and `hash`; an `UPDATE`/`DELETE` is refused by `messages_worm` (MSG-02); flipping one stored `body` byte makes the resolver report `chainOk:false` from that seq onward and emits `ARCHIVE_CHAIN_BROKEN` |
| policy | `packages/server/test/integration/messaging/policy.test.ts` | a counterparty firm absent from `firms.policy.permittedCounterpartyFirms` gives `canSend:false` `MESSAGE_POLICY_BLOCKED` and `POST /rooms` `403`; a `wall_tag` mismatch gives `ETHICAL_WALL`; a `newsroom` user is walled from every other desk (SEC-06); an open `legal_holds` row sets `policy.legalHoldActive` |
| entitlement of attachments | `packages/server/test/integration/functions/MSG.entitlement.test.ts` | the same seeded message read by `pm@demo` and `eod@demo`: the `AAPL US Equity` chip is `330.27` for the first and `—` with `r:'TIER_EOD'` for the second, with identical `label` and `command` (MSG-04, ENTL-05) |
| pagination | `packages/server/test/integration/functions/MSG.page.test.ts` | `N=2` then PAGE FWD twice walks `seq` 5–6, 3–4, 1–2 with `meta.page.cursor` = `base64url({roomId,seq})` and no row repeated |
| screen | `packages/web/test/screens/MSG.test.tsx` | renders the golden for each `view`; a replayed `msg` frame for the active room appends a row and for another room bumps its `unread`; attachment cells register `live` on `q:42` and flash on a delta; every keymap action is reachable by keyboard; the composer owns printable keys and `Enter`; `payload === undefined` renders the skeleton; `PRESENCE_NOT_AVAILABLE` renders as a muted line |
| e2e | `packages/e2e/tests/messaging.spec.ts` | `pm@demo` runs `AAPL US Equity GP <GO>`, `MSG <GO>` in the next panel, `Alt+F` attaches the GP result, sends; a second browser context signed in as the dm counterparty receives the chip within 1 s over `room:<id>`, `Enter` on it opens `GP` in their panel, and as `eod@demo` the same chip shows `—` with `TIER_EOD` (MSG-04, ENTL-05, BUS-01) |

---

### IB — Instant Bloomberg

| Attribute | Value |
| --- | --- |
| Code / aliases | `IB` is **not a manifest**: it is an alias of `MSG` (FUNCTIONS.md §6, 38 manifests) with `aliasParams` `{ IB: { view: 'rooms' } }` |
| Tier / category | 1 / messaging |
| Asset classes → variants | `none → default` (MSG's) |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 (MSG's; the alias never versions separately) |
| Files | none of its own — `packages/core/src/functions/manifests/MSG.ts` declares `aliases: ['IB','CHAT']`; `fixtures/golden/functions/MSG.rooms.{json,csv}` is the alias-launch golden |
| Requirements | (FUNC-01) (TERM-01) (TERM-03) (MSG-01) (MSG-03) (MSG-04) |

This entry exists because BRIEF §6 lists the Tier 1 catalogue as `MSG`/`IB`. Everything an implementer
needs is in the `MSG` entry above; what follows is the complete list of what the alias changes and the
tests that pin it. `registry.canonical('ib') === 'MSG'` and `registry.canonical('IB')` likewise
(case-insensitive, FUNCTIONS.md §1.7); `IB` may never be registered as a `code`.

#### Params
```ts
// packages/core/src/functions/manifests/MSG.ts
aliasParams: { IB: { view: 'rooms' } },      // merged BEFORE MsgParams.parse (runner step 1, FUNCTIONS.md §1.4.3)
```
No other key differs: the alias produces `MsgParams.parse({ view:'rooms', ...body.params })`, so every
default of `MSG` (`roomId:null`, `to:null`, `limit:50`, `filter:''`, `unreadOnly:false`) applies and an
explicit `VIEW=` on the command line overrides the alias default.

#### Argument grammar
`MSG`'s grammar verbatim (`positional [{ name:'to', type:'string', optional:true }]`, `keyed { ROOM, VIEW, N, FILTER, UNREAD }`, no `rest`) — the parser resolves the alias to the canonical code before `parseArgs` runs, so there is no alias-specific grammar.
Examples: `IB` → `{ view:'rooms', roomId:null, to:null, limit:50, filter:'', unreadOnly:false }` · `IB jane.doe` → `{ view:'rooms', to:'jane.doe' }` · `IB VIEW=SPLIT ROOM=1` → `{ view:'split', roomId:1 }` (the explicit `VIEW=` wins over `aliasParams`).
Autocomplete ranks `IB` as a function row whose `insertText` is `IB` and whose label is `IB — Instant Bloomberg (MSG)`; the ticker prefix `IBM US Equity` must still rank above it for the query `IB` when the panel has no security (FUNCTIONS.md §3.3 / §6 row `IB`).

#### Payload
`MsgPayload` unchanged, with `view: 'rooms'` from the alias default. `meta.resultId` and the cached
result record `alias:'IB'` (`CachedResult.alias`, runner step 9) and `usage_events.details.alias = 'IB'`
(step 10), which is the only trace of the alias in the payload envelope (FUNC-04).

#### Data dependencies
Identical to `MSG` in every row (`rooms`, `room_members`, `messages`, `message_reads`, `legal_holds`,
`firms`, `users`, plus the attachment reference lookups; `data.messaging.*`; `plant.snapshotMany`;
subjects `room:<roomId>` and `q:<instrumentId>`; field ids `[PX_LAST, CHG_NET_1D, CHG_PCT_1D, LAST_TRADE_TIME]`).
The alias adds and removes nothing: it selects a view of an already-resolved payload.

#### Resolver
`packages/server/src/functions/MSG/resolve.ts`, unchanged — steps 1–11 of the `MSG` entry run exactly as
written, with `params.view === 'rooms'`. Step 3's active-room selection still runs (so `IB` lands on the
room list **with** the most recent room loaded behind it and one `GO` away), and step 4 still honours
`params.to`. Same budget: 3 DB round-trips, zero provider calls, first paint < 500 ms p95.

#### Live
Identical `LiveSpec` to `MSG`: every `room:<roomId>` in `rooms[]` plus the active room's attachment
`q:` subjects, `fields ['PX_LAST','CHG_NET_1D','CHG_PCT_1D','LAST_TRADE_TIME']`, `conflationMs: 250`,
`essential: [active.room.subject]`. Because `view:'rooms'` renders `grid#rooms` full width, the unread
counters of every room are the visible live surface: a `msg` frame for a non-active room bumps that row's
`unread` cell and re-sorts the grid on `lastMessageAt` (TERM-08 flash applies to the `unread` cell).

#### Screen
`packages/web/src/screens/MSG/Screen.tsx`, branch `view === 'rooms'` (specified in the `MSG` Screen
section). The alias changes exactly three rendered strings and the initial focus:
title `IB · Instant Bloomberg · <me.displayName> @ <me.firmName>` (the shell substitutes the launched
alias into the title through `ScreenProps.ctx` — `MSG` renders `MSG · Messaging · …`); the footer note
`IB and MSG are the same screen`; `initialFocus:'rooms'` instead of `'composer'`. Layout, formats,
skeleton, badges and the rendering of `meta.entitlement` / `meta.unavailable` are those of the `MSG`
entry's `view:'rooms'` branch.

#### Keyboard
`MSG`'s keymap verbatim (one `keymap` array on one manifest). Only the resting focus differs, so the
first keys a user meets are `Enter` on `grid#rooms` (`open-room`), `Ctrl+ArrowUp`/`Ctrl+ArrowDown`
(`prev-room`/`next-room`), `Alt+U` (`toggle-unread`), `Alt+N` (`new-room`) and `Alt+D` (`open-directory`);
`Alt+S`/`Alt+F`/`Alt+W` remain composer-scoped and are inert until `Alt+R` or `Enter` opens a room.

#### CSV
`MSG`'s `CsvSpec` verbatim, including the long-format `section` column and `pageable` cursor
(`base64url(JSON.stringify({ roomId, seq }))`, PAGE FWD = older). The filename is computed from the
payload, not the alias, so `IB` with no active room exports `MSG_rooms_20260915T184128Z.csv` and `IB ROOM=1`
exports `MSG_room1_20260915T184128Z.csv` — the file names the manifest, which is what a reviewer diffing
an export against `/admin/export/messages` needs.

#### Help
`HELP IB` renders `MSG`'s `HelpSpec` (`registry.canonical` runs first) with the header line
`IB — alias of MSG (Instant Bloomberg opens on the room list)`. summary, description, params, sources
(`['internal.user','cboe.quotes','yahoo.chart']`) and related (`['HELP','DES','GP','W','PORT']`) are
`MSG`'s; no alias-specific help text exists, so the two can never drift.

#### Unavailable and reason codes
`MSG`'s table applies unchanged. Two of its entries are the ones an `IB` launch meets first, because the
room list is the landing view: `{ field:'active', reason:'NOT_APPLICABLE', detail:'NO_ROOMS: you are not a
member of any room — Alt+N to start one' }` renders as the grid's `emptyText`, and
`{ field:'members[].presence', reason:'NO_SOURCE', detail:'PRESENCE_NOT_AVAILABLE: …' }` renders as the
muted line under the grid, since the room list is where a user would look for who is online.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| alias invariants | `packages/core/test/functions/manifests.test.ts` | `registry.canonical('IB') === 'MSG'` and `registry.canonical('ib') === 'MSG'`; `'IB'` is not a key of `manifests`; `aliasParams.IB` parses under `MsgParams`; no other manifest claims `IB` or `CHAT` |
| command parse | `packages/core/test/command/parser.test.ts` | `parse('IB')[0]` → `{ code:'MSG', alias:'IB', params:{ view:'rooms' } }`; `parse('IB VIEW=SPLIT')[0].params.view === 'split'`; `parse('IB jane.doe')[0].params.to === 'jane.doe'`; with no security loaded, `rank('IB')` puts `IBM US Equity` above the `IB` function row |
| golden payload | `packages/server/test/integration/functions/MSG.golden.test.ts` | the `IB` launch at the frozen clock deep-equals `fixtures/golden/functions/MSG.rooms.json`, which differs from `MSG.default.json` in `view` only (asserted field-by-field, not by re-recording) |
| runner alias | `packages/server/test/integration/functions/runner.test.ts` | `POST /api/v1/functions/IB/run` returns `200` with `meta` whose cached result has `code:'MSG'`, `alias:'IB'`; the `usage_events` row is `kind:'fn.launch'`, `code:'MSG'`, `details.alias:'IB'` (FUNC-04) |
| screen | `packages/web/test/screens/MSG.test.tsx` | the `view:'rooms'` branch titles `IB · Instant Bloomberg · …` when launched as `IB`, focuses `grid#rooms`, renders no composer, and bumps a non-active room's `unread` on a replayed `msg` frame |
| e2e | `packages/e2e/tests/messaging.spec.ts` | `IB <GO>` lands on the room list with both seeded rooms; `Enter` on `Demo Capital` opens the transcript; `MSG <GO>` in the same panel returns to the split view with the same room loaded (TERM-03 panel context) |

---

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
