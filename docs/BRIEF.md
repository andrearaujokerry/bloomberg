# Terminal clone — product & architecture brief

This document fixes the decisions that every design and implementation task builds on. It is
the answer to SCOPE-01..05 in [REQUIREMENTS.md](./REQUIREMENTS.md) and the constraint set for
everything else. Where a requirement cannot be met by software alone (licensing, staffing,
regulatory registration, hardware feeds) we build the *mechanism* the requirement describes
(a licence registry, an access log, a replay harness, a normalisation schema) against the
public sources we can actually reach, and document the gap.

## 1. Product wedge (SCOPE)

- **Wedge:** US-listed equities and ETFs, US Treasuries and money-market rates, with global
  equity indices, G10 FX and listed US equity options as context. One asset-class-first
  terminal, not global multi-asset.
- **Persona:** buy-side equity PM / analyst on a desk. Secondary: rates analyst.
- **Competitive claim:** an open, keyboard-first terminal whose every number carries
  source-level provenance and is served from official primary sources.
- **Explicit v1 non-goals:** order execution (EXEC-*), Excel add-in (API-04 — replaced by CSV
  export and the JS SDK), chat federation (MSG-05), mobile parity, sell-side research
  distribution (NEWS-06), SOC 2 / ISO certification (SEC-07), binary exchange protocols and
  multicast (FEED-01/02/09/10 — replaced by HTTP feed handlers over the same normalisation
  model), multi-datacentre PoPs (NFR-03), 24/7 human helpdesk (TERM-09 second press opens a
  ticket record instead), evaluated fixed-income pricing vendors (DATA-04 — Treasuries only).
- **Build/buy line:** everything is built here; there is no budget for vendors. Reference
  identifiers come from OpenFIGI (Bloomberg's own open symbology), fundamentals from SEC XBRL.

## 2. Data sources (DATA, verified reachable without API keys on 2026-09-15)

"As close to Bloomberg's official sources as possible" resolves to, in priority order:

| Domain | Source | Endpoint(s) | Notes |
| --- | --- | --- | --- |
| Symbology (REF-01) | **OpenFIGI** (Bloomberg) | `POST https://api.openfigi.com/v3/mapping`, `POST /v3/search` | FIGI, composite FIGI, share-class FIGI, security type, market sector. Keyless: 25 req/min, 10 jobs/req. Optional `OPENFIGI_API_KEY` raises limits. |
| News (NEWS-01) | **Bloomberg RSS** | `https://feeds.bloomberg.com/{markets,economics,politics,technology,wealth,industries}/news.rss` (301 → bloomberg.com/feeds/…) | Headline, link, description, pubDate, media. Follow redirects. |
| Filings & fundamentals (DATA-06, NEWS-04) | **SEC EDGAR** | `https://www.sec.gov/files/company_tickers.json`, `https://data.sec.gov/submissions/CIK##########.json`, `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`, `https://data.sec.gov/api/xbrl/frames/us-gaap/{concept}/USD/CY{yyyy}.json`, 8-K atom `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=40&output=atom` | Requires a descriptive `User-Agent` with contact email. 10 req/s max. Full-text search (efts) is blocked. |
| Exchange quotes (DATA-03) | **Cboe delayed quotes** | `https://cdn.cboe.com/api/global/delayed_quotes/quotes/{SYMBOL}.json` (`_SPX`, `_VIX` for indices), `/options/{SYMBOL}.json` (full chain with greeks/IV), `/symbol_book/symbol-book.json` (full universe), `/european_indices/index_quotes/{CODE}.json` | Exchange-published, 15-min delayed. Fields: current_price, bid/ask/sizes, open/high/low/close, prev_day_close, volume, iv30, seqno, last_trade_time. |
| Intraday & daily bars, dividends/splits, FX, indices | **Yahoo Finance chart v8** | `https://query1.finance.yahoo.com/v8/finance/chart/{SYM}?range=1d&interval=1m`, `…?range=max&interval=1d&events=div%7Csplit`; symbols like `^GSPC`, `^FTSE`, `EURUSD=X`, `^TNX` | Unofficial, keyless, **requires a browser-like `User-Agent` header** (returns an empty body without one). Used for intraday 1-minute bars, full daily history, non-US indices, FX, and corporate-action events. `v7/quote` and `quoteSummary` need a crumb — do not use. |
| Autocomplete fallback | Yahoo search v1 | `https://query2.finance.yahoo.com/v1/finance/search?q=…&quotesCount=8&newsCount=0` | Only as a fallback for symbols missing from the local master. |
| Macro (DATA-07) | **FRED** | `https://fred.stlouisfed.org/graph/fredgraph.csv?id={SERIES}` (no key), `https://fred.stlouisfed.org/releases/calendar` (HTML) | JSON API needs `FRED_API_KEY`; CSV does not. |
| Rates | **Fed H.15**, **NY Fed** | `https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&…&filetype=csv`; `https://markets.newyorkfed.org/api/rates/all/latest.json`, `/api/rates/secured/sofr/last/{n}.json` | SOFR, EFFR, OBFR, BGCR, TGCR with percentiles and volume. |
| Treasury curve (ANAL-02) | **US Treasury** | `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=yyyymm` | Slow (~18 s). Cache aggressively. Par yields 1M–30Y. |
| Labour stats | **BLS** v2 | `https://api.bls.gov/publicAPI/v2/timeseries/data/{SERIES}` | Keyless: 25 queries/day. |
| Global macro | World Bank, IMF DataMapper | `https://api.worldbank.org/v2/country/{ISO}/indicator/{ID}?format=json`, `https://www.imf.org/external/datamapper/api/v1/{ID}/{ISO}` | Annual series. |
| FX reference (ECB) | frankfurter.dev (ECB mirror) | `https://api.frankfurter.dev/v1/latest?base=USD`, `/v1/2024-01-01..2024-12-31?base=USD` | ecb.europa.eu itself is not reachable from this network. |
| Index constituents (REF-07) | **SEC N-PORT** (SPY, CIK 0000884394) and **SPDR** holdings file | N-PORT: `https://data.sec.gov/submissions/CIK0000884394.json` → latest `NPORT-P` accession → `https://www.sec.gov/Archives/edgar/data/884394/{accession-no-dashes}/primary_doc.xml` (one `<invstOrSec>` per holding with name, CUSIP, ISIN, balance, value, pctVal). SPDR daily file: `https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx` (xlsx, 54 KB) | S&P 500 membership and weights from the ETF that tracks it: N-PORT is the official regulatory filing (quarterly, monthly-dated), the SPDR file is the issuer's daily publication. iShares/Invesco CSV endpoints return HTML or 4xx — do not use. Fixture: `sec-nport-SPY-primary_doc.xml`, `ssga-spy-holdings.xlsx`. |
| Short interest | FINRA | `https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest?limit=…` | Keyless. |
| Fed communications | Fed RSS / FOMC calendar | `https://www.federalreserve.gov/feeds/press_all.xml`, `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` | |
| Crypto (context only) | CoinGecko | `https://api.coingecko.com/api/v3/simple/price?ids=…&vs_currencies=usd` | |

Not reachable / not usable keyless: Finnhub, Polygon, FRED JSON, Nasdaq.com API, CME FedWatch,
OFR, SEC full-text search, ECB direct, Treasury fiscaldata, Stooq (JavaScript challenge page),
iShares/Invesco holdings downloads, slickcharts. The Cboe symbol book (`symbol-book.json`,
35,618 entries of `{name, company_name}`) is the US listed-symbol universe for autocomplete
seeding; the SEC `company_tickers.json` (ticker → CIK → name) links it to filings. WIRP therefore derives the implied
policy path from the SOFR/Treasury bill curve rather than fed-funds futures; EE has no
consensus-estimates source and is built from SEC actuals (history, next expected date) with the
estimate columns marked unavailable with a reason code.

Every provider adapter must: (1) record raw responses into the replay store so tests never
touch the network (FEED-08, QA-02); (2) stamp provenance on every value (DATA-10); (3) be
registered in the licence registry with its terms (DATA-09); (4) be rate-limited and
cache-aware; (5) surface staleness (TERM-12).

## 3. Stack

- **Language:** TypeScript everywhere (strict). Node 22. npm workspaces monorepo (pnpm is not
  installed). ESM.
- **Server:** Fastify 5 + `ws`. Postgres 14 (local, `bloomberg_dev` / `bloomberg_test` exist;
  extensions available: `pg_trgm`, `btree_gist`, `pgcrypto`, `uuid-ossp`; **no** TimescaleDB
  or pgvector). Drizzle ORM with committed SQL migrations. `zod` for all request/response
  schemas. `pino` logging with per-request trace ids (OPS-07).
- **Client:** Vite + React 19 + zustand. Canvas-rendered charts (custom renderer, no chart
  library). Virtualised live grid with per-cell flash. IBM Plex Mono-style density.
- **SDK:** `@terminal/sdk` — typed REST + WebSocket client and the field dictionary, used by
  the web client itself so terminal and API cannot disagree (API-05).
- **Tests:** Vitest (unit + integration against real Postgres `bloomberg_test`), React Testing
  Library + jsdom for components, Playwright for end-to-end terminal flows, golden-dataset
  analytics regression (QA-01), provider replay tests from recorded fixtures (QA-02), fuzz tests
  on parsers (QA-05). `npm test` must pass offline.

## 4. Monorepo layout

```
package.json                 npm workspaces, root scripts (dev, build, test, db:*)
tsconfig.base.json
docs/                        REQUIREMENTS, BRIEF, ARCHITECTURE, DATA_MODEL, API, FUNCTIONS, PROVIDERS, TESTING
packages/core                pure domain: ids, calendars, day counts, analytics, formula language, function manifests. No IO.
packages/server              Fastify app, Drizzle schema + migrations, providers, ticker plant, function resolvers, seed, replay store
packages/sdk                 typed client + field dictionary + wire types (shared by web and external users)
packages/web                 Vite React terminal client
packages/e2e                 Playwright specs
fixtures/                    recorded provider responses (replay), golden analytics datasets
```

## 5. Load-bearing contracts (must be designed before parallel implementation)

1. **Normalised instrument & quote model (FEED-03).** One `Instrument` (issuer → issue →
   instrument → listing → market-data line, REF-02), one `Quote` state (bid/ask/last/sizes,
   OHLC, volume, session state, three timestamps — source, capture, publish — FEED-05, staleness
   tier). Asset classes: `equity`, `etf`, `index`, `fx`, `govt` (Treasury bill/note/bond),
   `option`, `future` (shape only), `crypto`, `rate` (SOFR etc.), `econ` (macro series).
2. **Bitemporal reference tables (REF-03).** `valid_from/valid_to` and `tx_from/tx_to` on every
   security-master and fundamentals row, with `btree_gist` exclusion constraints and an
   `as_of(valid_at, known_at)` query helper. Point-in-time fundamentals keyed on `filed_at`
   (STOR-06). Corporate-action adjustment computed on read with a policy parameter (REF-09).
3. **Function framework (FUNC-01/02).** A function is a manifest: `code`, `name`, `tier`,
   `assetClasses`, `params` (zod), server `resolve(ctx, params) → payload`, client
   `Screen(payload)`, `toCsv(payload)`. Registry shared through the SDK. Polymorphic by asset
   class. Every launch, param change and export emits a usage event (FUNC-04).
4. **Real-time protocol (BUS-01..08).** WebSocket: `subscribe {subjects[], fields[]}` →
   `snapshot` then `delta` messages with per-subject sequence numbers; per-subscriber
   conflation at a configurable interval with latest-value guarantee; slow-consumer downgrade;
   resubscribe-on-reconnect resync. Server-side entitlement check per subject/field/tier with
   downgrade reason codes (ENTL-05).
5. **Command grammar (TERM-01..03).** `[SECURITY] [SECTOR] [FUNCTION] [ARGS] <GO>`. Market
   sectors: `Equity`, `Index`, `Curncy`, `Govt`, `Corp`, `Comdty`, `Mtge`, `Muni`, `Pfd`,
   `M-Mkt`, `Crypto`. Function-only input applies to the panel's current security;
   security-only input reloads the panel's current function. Autocomplete merges instruments,
   functions, people and topics in one ranked list.
6. **Entitlements (ENTL-01..06).** Evaluated server-side per user × instrument × field class
   × latency tier × usage type (display/export/api). Default tier is `delayed`. Every access
   is logged (batched, async) with user, instrument, field, ts, purpose. Monthly per-source
   declarations are a query over the log.

## 6. Function catalogue for v1

Tier 1: `DES`, `GP`, `GIP`, `HP`, `Q`, `QM`, `W`, `TOP`, `N`, `NI`, `MSG`/`IB`, `WEI`, `HELP`,
`SECF`. Tier 2: `FA`, `EE` (SEC actuals; estimates marked unavailable), `EQS`, `RV`, `CN`,
`CACS`, `CF`, `ECO`, `PORT`, `HDS` (13F where feasible; otherwise ETF holders), `MEMB`,
`BTMM`, `FXC`, `WB`. Tier 3: `YAS` (Treasuries), `CRVF`/`ICVS` (Treasury par + SOFR curves),
`WIRP` (implied path from the money-market curve), `OVML`, `OMON`, `SWPM` (SOFR OIS swap),
`SRCH` (Treasury search by T&C), `GC` (Treasury benchmark curve chart), `FED`, `CRYP`.

## 7. Definition of done

- `npm install && npm run db:migrate && npm run db:seed && npm run dev` brings up server and
  client; the terminal loads with the seeded universe and live (delayed) quotes.
- `npm test` passes offline in CI conditions (fixtures only); `npm run test:live` optionally
  exercises real providers.
- Every requirement in REQUIREMENTS.md is mapped in `docs/TRACEABILITY.md` to one of:
  implemented (with test names), partially implemented (with gap), or out of scope (with reason).
