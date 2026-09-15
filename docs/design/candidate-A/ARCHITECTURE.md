# ARCHITECTURE — candidate A ("a correct number first")

This candidate is organised around one rule: **every number the terminal shows is reproducible from
stored inputs, carries provenance, was read as-of an explicit (valid_at, known_at) pair, was
corporate-action-adjusted on read under a named policy, and passed a server-side entitlement
decision that was logged.** Everything else (screens, charts, chat) is a consumer of that spine.

Companion documents: [DATA_MODEL.md](./DATA_MODEL.md) (DDL), [API.md](./API.md) (REST + WS),
[FUNCTIONS.md](./FUNCTIONS.md), [PROVIDERS.md](./PROVIDERS.md), [CLIENT.md](./CLIENT.md),
[TESTING.md](./TESTING.md), [WORKPLAN.md](./WORKPLAN.md), [TRACEABILITY.md](./TRACEABILITY.md).

---

## 1. System overview

```
                 ┌──────────────────────────────────────────────────────────────────────────────┐
                 │  packages/web  (Vite + React 19 + zustand, canvas charts, live grid)          │
                 │  command line ─► parser (core) ─► panel router ─► Screen(payload)            │
                 └───────────────▲──────────────────────────────────▲───────────────────────────┘
                                 │ REST (zod, @terminal/sdk)          │ WS (snapshot/delta, seq, conflation)
┌────────────────────────────────┴──────────────────────────────────┴──────────────────────────────┐
│ packages/server (Fastify 5 + ws)                                                                  │
│                                                                                                   │
│  routes/*  ─► entitlements/evaluator ─► functions/runtime ─► resolvers/<CODE>.ts ─► repositories   │
│                    │ access_log (batched)        │ usage_events           │ as_of(valid_at,known_at)│
│                    ▼                             ▼                        ▼ adjust-on-read (policy) │
│  plant/ticker-plant  ◄── ingest/normalisers ◄── providers/<adapter> ◄── http (rate-limit, cache)    │
│      │ per-subject seq, composite rules            │ provenance rows        │ replay store (fixtures)│
│      ▼ conflation per subscriber, slow-consumer    ▼                        ▼                       │
│  plant/ws-server                                ingest/scheduler        replay/harness             │
└───────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                            │ Drizzle + committed SQL migrations
                                   ┌────────▼────────┐
                                   │ Postgres 14      │ btree_gist exclusion (bitemporal), pg_trgm,
                                   │ bloomberg_dev    │ declarative partitions (bars, ticks, logs)
                                   └─────────────────┘
packages/core  — pure TS: ids, calendars, day counts, analytics, adjustment maths, formula language,
                 command grammar, function manifests. No IO, no Date.now() (clock injected).
packages/sdk   — zod wire schemas (REST + WS), field dictionary, typed REST/WS client, function catalogue.
packages/e2e   — Playwright flows against `npm run dev` with fixtures-only providers.
fixtures/      — recorded provider responses (replay), normalised goldens, analytics goldens, sessions.
```

### 1.1 Dependency direction (enforced by `tsconfig` project references and an ESLint boundary rule)

| Package | May import | Never imports |
| --- | --- | --- |
| `@terminal/core` | nothing outside itself (only `zod` for param schemas) | Node built-ins, `pg`, React, `Date.now()` (a `Clock` is passed in) |
| `@terminal/sdk` | `core`, `zod` | server, web |
| `@terminal/server` | `core`, `sdk`, Fastify, ws, drizzle, pg, pino | web |
| `@terminal/web` | `core`, `sdk`, React | server |
| `@terminal/e2e` | Playwright only (talks over HTTP/WS) | any package source |

---

## 2. Package boundaries and module list (file paths)

### 2.1 `packages/core/src`

| Path | Responsibility |
| --- | --- |
| `ids/figi.ts`, `ids/isin.ts`, `ids/cusip.ts`, `ids/sedol.ts` | Format + check-digit validation (ISIN Luhn over letter expansion, CUSIP mod-10 "double-add-double", SEDOL weighted 1-3-1-7-3-9). |
| `ids/occ.ts` | Parse/format OCC option symbols: `AAPL260916C00245000` → `{root:'AAPL', expiry:'2026-09-16', cp:'C', strike:245}` (last 8 digits = strike×1000, preceding char C/P, preceding 6 digits yymmdd, remainder = root). |
| `ids/security-ref.ts` | `SecurityRef` parser for `AAPL US Equity`, `SPX Index`, `EURUSD Curncy`, `912797VE4 Govt`, `T 4.25 08/15/36 Govt`, `AAPL 9/16/26 C245 Equity`, `/isin/US0378331005`, `/figi/BBG000B9XRY4`. |
| `calendars/calendar.ts`, `calendars/xnys.ts`, `calendars/sifma.ts`, `calendars/usgov.ts`, `calendars/fx.ts` | Holiday rules (NYSE incl. early closes; SIFMA bond market; US federal; FX T+2 spot with USD holidays), business-day conventions (`following`, `modified_following`, `preceding`, `none`), `combine([...])` union rule. |
| `daycount/*.ts` | `ACT/360`, `ACT/365F`, `ACT/ACT ISDA`, `ACT/ACT ICMA`, `30/360 US`, `30E/360`. |
| `analytics/bond/*` | Price↔yield (street convention, semiannual), accrued (ICMA), Macaulay/modified duration, convexity, DV01, key-rate durations (par-curve bump), bill discount↔investment yield (both Treasury formulas), cashflow schedule generation. |
| `analytics/curve/*` | Bootstrap (bills + par coupon bonds), OIS bootstrap from SOFR fixings + par OIS quotes, interpolation (`linear_zero`, `log_linear_df`, `monotone_convex`), discount/forward/zero accessors, curve `Snapshot` (inputs hash for ANAL-08). |
| `analytics/options/*` | BSM with continuous dividend yield, Black-76, CRR/JR binomial with American exercise, Monte Carlo (antithetic + control variate), implied vol (Brent + Newton), full greeks (delta, gamma, vega, theta, rho, vanna, volga). |
| `analytics/vol/*` | Surface from listed chain (forward from put-call parity, SVI slice fit, arbitrage checks). |
| `analytics/swap/*` | SOFR OIS schedule generation (annual fixed vs daily-compounded float, ACT/360, T+2, modified following, SIFMA), PV, par rate, DV01. |
| `analytics/wirp/*` | Implied policy path: step-function OIS/bill forward curve between FOMC dates → implied rate per meeting and cut/hike probabilities relative to 25bp steps. |
| `analytics/stats/*` | Returns (simple/log), volatility, correlation, beta, drawdown, Sharpe/Sortino/information ratio, OLS factor regression; explicit conventions object. |
| `analytics/portfolio/*` | Exposure, Brinson-Fachler attribution, ex-post tracking error, scenario P&L (parallel/keyrate shifts, equity shock, FX), historical/parametric VaR. |
| `adjust/corporate-actions.ts` | `adjustmentFactors(actions, policy)` and `applyAdjustment(bars, factors)` — the single implementation used by REST, functions and CSV export (REF-09, API-05). |
| `quote/quote-state.ts`, `quote/staleness.ts` | Normalised `QuoteState`, merge rules, staleness computation from expected interval and session state. |
| `formula/{lexer,parser,evaluator,ast}.ts` | Formula language for computed series (`AAPL US Equity / SPX Index`, `.5*A+.5*B`, `RATIO(A,B)`, `SPREAD(A,B)`, `NORM(A,100)`). |
| `command/{tokenizer,grammar,parser,rank}.ts` | `[SECURITY] [SECTOR] [FUNCTION] [ARGS] <GO>` parser and the autocomplete ranking function (pure; index supplied by caller). |
| `functions/manifest.ts`, `functions/catalogue/<CODE>.ts`, `functions/registry.ts` | Manifest type, one manifest per function (code, aliases, tier, assetClasses, zod params, payload type, csv spec, help text, dependencies). |
| `fields/ids.ts` | `FieldId` union type generated from the SDK dictionary (build step) so core code can reference fields type-safely. |
| `clock.ts` | `interface Clock { now(): Date }`; `SystemClock` lives in server only. |

### 2.2 `packages/sdk/src`

| Path | Responsibility |
| --- | --- |
| `wire/envelope.ts` | `ErrorEnvelope`, `Meta` (traceId, validAt, knownAt, provenance, staleness, entitlement). |
| `wire/rest.ts` | zod schemas for every route in API.md (request + response), exported as `Rest.<Route>`. |
| `wire/ws.ts` | zod schemas for every WS message, `DowngradeCode`, `ReasonCode`. |
| `wire/data-request.ts` | The one `DataRequest`/`DataResponse` model (API-02). |
| `fields/dictionary.ts`, `fields/types.ts`, `fields/version.ts` | Versioned field dictionary (API-07). |
| `client/rest-client.ts` | Typed fetch wrapper: validates responses with zod, propagates `x-trace-id`. |
| `client/ws-client.ts`, `client/subscription.ts` | Reconnect, resubscribe-on-reconnect, seq handling, snapshot-after-resync semantics, downgrade events. |
| `functions/index.ts` | Re-exports the core catalogue + payload types so web and API users share it. |
| `index.ts` | Public surface. |

### 2.3 `packages/server/src`

| Path | Responsibility |
| --- | --- |
| `index.ts`, `app.ts`, `config.ts` | Bootstrap, plugin registration, env (`DATABASE_URL`, `PROVIDER_MODE=replay|live|record`, `OPENFIGI_API_KEY?`, `SEC_USER_AGENT`). |
| `db/client.ts`, `db/schema/*.ts`, `db/migrations/*.sql`, `db/bitemporal.ts`, `db/partitions.ts` | Drizzle client; schema files per table group; committed SQL; `asOf()` helper + `writeVersion()`; partition maintenance. |
| `refdata/{issuers,issues,instruments,listings,md-lines,identifiers,terms}.repo.ts`, `refdata/resolve.ts` | Bitemporal repositories; `resolve(SecurityRef, asOf) → Instrument`. |
| `calendars/repo.ts` | Loads calendar tables into core calendar objects. |
| `providers/adapter.ts`, `providers/http.ts`, `providers/replay-store.ts`, `providers/provenance.ts`, `providers/registry.ts`, `providers/<name>.ts` | Adapter contract and one adapter per source (PROVIDERS.md). |
| `ingest/scheduler.ts`, `ingest/jobs/<job>.ts`, `ingest/normalisers/<name>.ts` | Cron-like scheduler with per-provider rate budgets; jobs write normalised rows with provenance. |
| `history/{bars,ticks,intraday}.repo.ts` | Bars/ticks reads with partition pruning; adjustment applied via `ca/adjust-on-read.ts`. |
| `ca/adjust-on-read.ts`, `ca/repo.ts` | Loads corporate actions as-of, calls core adjust. |
| `pit/fundamentals.repo.ts`, `pit/standardise.ts` | Point-in-time facts keyed on `filed_at`; standardised line-items via concept map. |
| `econ/repo.ts`, `curves/repo.ts`, `curves/build.ts`, `indices/repo.ts`, `news/{repo,entity-linker,ranker}.ts` | Domain repositories. |
| `plant/ticker-plant.ts`, `plant/subject.ts`, `plant/composite.ts`, `plant/policy-tier.ts`, `plant/conflator.ts`, `plant/ws-server.ts`, `plant/session.ts`, `plant/backpressure.ts` | In-memory composite state, per-subject sequencing, tiers, per-subscriber conflation, slow-consumer handling. |
| `entitlements/{evaluator,licence-registry,access-log,quotas,declarations}.ts` | Server-side entitlement decision + logging + monthly declarations. |
| `auth/{password,webauthn,sessions}.ts`, `routes/auth.ts` | Login, FIDO2, single-session enforcement. |
| `functions/{runtime,context,resolver-registry,export}.ts`, `functions/resolvers/tier1/<CODE>.ts`, `.../tier2/`, `.../tier3/` | Function execution runtime and resolvers. |
| `routes/{reference,data,functions,search,news,messages,workspaces,watchlists,portfolios,alerts,export,fields,admin,health}.ts` | REST routes (API.md). |
| `search/{index,autocomplete}.ts` | In-memory ranked index + pg_trgm fallback. |
| `messaging/{rooms,messages,surveillance}.ts`, `alerts/engine.ts` | Chat with immutable archive, lexicon surveillance, alert evaluation. |
| `observability/{logger,trace,usage-events,metrics,data-quality}.ts` | pino, trace ids, usage events sink, Prometheus-style metrics, DQ monitors. |
| `replay/{harness,diff,session-recorder}.ts` | Deterministic session replay and diff. |
| `seed/{seed,universe,users,calendars,licences}.ts` | Seed from the replay store (offline). |

### 2.4 `packages/web/src`

| Path | Responsibility |
| --- | --- |
| `main.tsx`, `App.tsx` | Bootstrap, session gate, workspace load. |
| `shell/{Terminal,Panel,CommandLine,Autocomplete,StatusBar,KeyBar,HelpOverlay}.tsx`, `shell/keymap.ts`, `shell/router.ts` | Shell (CLIENT.md). |
| `state/{session,workspace,panels,quotes,functions,alerts}.store.ts` | zustand stores. |
| `ws/{connection,quote-bus}.ts` | WS lifecycle, imperative per-cell subscription bus. |
| `grid/{LiveGrid,virtualiser,cell-registry,flash,sort-group,keyboard}.ts(x)` | Live grid component. |
| `chart/{ChartCanvas.tsx,renderer/*,studies/*,annotations/*,events.ts}` | Canvas chart. |
| `screens/tier1/<CODE>/{Screen.tsx,toCsv.ts}` etc. | Screens per function. |
| `format/{number,date,staleness,colour}.ts`, `theme/{tokens.css,density.ts}` | Formatting and colour semantics. |
| `export/csv.ts` | Calls the server export endpoint, never computes numbers itself. |

---

## 3. Load-bearing models (normalised instrument and quote)

### 3.1 Instrument hierarchy (REF-01/02) as TypeScript

```ts
// packages/core/src/refdata/types.ts
export type AssetClass = 'equity'|'etf'|'index'|'fx'|'govt'|'option'|'future'|'crypto'|'rate'|'econ';
export type MarketSector = 'Equity'|'Index'|'Curncy'|'Govt'|'Corp'|'Comdty'|'Mtge'|'Muni'|'Pfd'|'M-Mkt'|'Crypto';

export interface Bitemporal { validFrom: string; validTo: string; txFrom: string; txTo: string; provenanceId: number }

export interface Issuer extends Bitemporal { issuerId: number; name: string; lei?: string; cik?: string; country?: string; sic?: string; entityType: 'operating'|'fund'|'sovereign'|'index_provider'|'other' }
export interface Issue  extends Bitemporal { issueId: number; issuerId: number; assetClass: AssetClass; shareClassFigi?: string; isin?: string; cusip?: string; sedol?: string; securityType: string; currency: string; name: string }
export interface Instrument extends Bitemporal {
  instrumentId: number;              // immutable internal key (REF-01). Never a ticker.
  issueId: number; assetClass: AssetClass; marketSector: MarketSector;
  compositeFigi?: string; ticker: string; exchCode: string;   // OpenFIGI composite exch code, e.g. 'US'
  name: string; currency: string; primaryListingId?: number; status: 'active'|'delisted'|'pending';
}
export interface Listing extends Bitemporal { listingId: number; instrumentId: number; figi?: string; mic?: string; exchCode: string; localTicker: string; isPrimary: boolean }
export interface MdLine  extends Bitemporal { mdLineId: number; instrumentId: number; listingId?: number; providerId: string; providerSymbol: string; lineKind: 'composite'|'venue'|'derived'; intrinsicDelayMin: number; expectedIntervalMs: number }
```

### 3.2 Quote model (FEED-03, FEED-05, TERM-12)

```ts
// packages/core/src/quote/quote-state.ts
export type SessionState = 'pre'|'open'|'auction'|'halted'|'closed'|'post'|'unknown';
export type Tier = 'realtime'|'delayed'|'eod';
export type StalenessState = 'live'|'stale'|'closed'|'eod'|'unknown';

export interface QuoteTimestamps { source: string|null; capture: string; publish: string } // FEED-05 three timestamps (ISO-8601, UTC)

export interface QuoteFields {
  PX_LAST?: number; LAST_SIZE?: number; LAST_TRADE_TIME?: string;
  PX_BID?: number; PX_ASK?: number; BID_SIZE?: number; ASK_SIZE?: number;
  PX_OPEN?: number; PX_HIGH?: number; PX_LOW?: number; PX_CLOSE_1D?: number; PX_OFFICIAL_CLOSE?: number;
  PX_VOLUME?: number; VWAP?: number; CHG_NET_1D?: number; CHG_PCT_1D?: number; TICK_DIR?: 'up'|'down'|'flat';
  IVOL_30D?: number; SESSION_STATE?: SessionState;
}
export interface QuoteState {
  instrumentId: number; subject: string;              // 'q:<instrumentId>'
  fields: QuoteFields;
  fieldTs: Partial<Record<keyof QuoteFields, string>>;// per-field source timestamp where known
  ts: QuoteTimestamps; seq: number; providerSeq?: number;
  tier: Tier; delayMin: number;                       // intrinsic delay of the winning line
  staleness: { state: StalenessState; ageMs: number; expectedIntervalMs: number };
  lines: Record<number /*mdLineId*/, { providerId: string; ts: QuoteTimestamps; providerSeq?: number }>;
  provenanceId: number;                               // of the last applied update
  dq: string[];                                       // data-quality flags, e.g. 'CROSS_SOURCE_DIVERGENCE'
}
```

Merge rule (documented for BUS-05): `PX_LAST` comes from the entitled md line with the greatest
`ts.source`; bid/ask/sizes only from lines whose `lineKind='venue'|'composite'` and that publish a
book (Cboe); `PX_VOLUME = max(line volumes)` because every reachable source reports consolidated
volume; `PX_CLOSE_1D` from the primary line; divergence > 0.5 % between lines with source
timestamps within 60 s raises `dq: ['CROSS_SOURCE_DIVERGENCE']` and an `dq_events` row (OPS-03).

---

## 4. Request lifecycle: keystroke → command parse → function resolve → data → screen

```
 1. keystroke          web/shell/CommandLine.tsx        <16 ms: local echo + parse + autocomplete query (debounced 40 ms)
 2. parse              core/command/parser.ts            tokens → { security?: SecurityRef, sector?, function?: code, args[] }
                                                         missing security → panel.currentSecurity; missing function → panel.currentFunction (TERM-03)
 3. resolve security   POST /v1/resolve                  SecurityRef → { instrumentId, assetClass, display } (as_of now; cached 5 min client-side)
 4. launch             POST /v1/functions/:code/resolve  body { params, asOf?, panelId, traceId }
 5. entitlement        server/entitlements/evaluator.ts  per (user, instrument, fieldClass, tier, usage='display'); decision + access_log rows
 6. runtime            server/functions/runtime.ts       manifest.params.parse → resolver(ctx, params) with ctx = { db, asOf, clock, plant, entitlement, trace }
 7. data               repositories                      as_of(valid_at, known_at) reads; adjust-on-read; PIT fundamentals keyed on filed_at
 8. payload            FunctionPayload<T>                { data, meta: { traceId, validAt, knownAt, provenance[], staleness, unavailable[], downgrades[] } }
 9. usage event        observability/usage-events.ts     { kind:'launch', code, params, panelId, traceId } (FUNC-04)
10. screen             web/screens/<CODE>/Screen.tsx     first paint < 500 ms budget; live fields subscribe via WS using meta.subjects
11. export (optional)  GET /v1/export/functions/:code.csv?params=…&validAt=…&knownAt=…  re-resolves at same as-of → identical numbers (FUNC-03/API-05)
```

`ResolveContext` (server) — the only way resolvers touch data:

```ts
export interface ResolveContext {
  user: { userId: number; firmId: number };
  asOf: { validAt: Date; knownAt: Date };          // defaults: now/now; export re-supplies the payload's values
  clock: Clock; traceId: string; panelId?: string;
  db: Db;                                          // drizzle handle
  repos: Repositories;                             // refdata, history(adjusted), pit, econ, curves, indices, news …
  plant: PlantReader;                              // current QuoteState snapshot (entitlement-filtered)
  entitle: (req: EntitlementRequest) => Promise<EntitlementDecision>;
  usage: 'display'|'export'|'api';
}
```

---

## 5. Real-time lifecycle: provider poll → normaliser → ticker plant → conflated WS → grid cell flash

```
poll   ingest/jobs/cboe-quotes.ts    every 10 s per active symbol (rotating; ≤5 req/s budget) → raw JSON → replay store (record mode)
norm   ingest/normalisers/cboe.ts    raw → QuoteUpdate { instrumentId, mdLineId, fields, providerSeq: seqno, ts:{source:last_trade_time, capture} , provenanceId }
plant  plant/ticker-plant.ts         apply(update): if providerSeq <= line.providerSeq → drop (dup); merge per composite rule; seq++ ; publishTs = clock.now()
tier   plant/policy-tier.ts          derives per-tier views: delayed = as-is (intrinsic delay); eod = fields frozen at official close
fanout plant/subscriptions           subject 'q:<id>' → subscribers; each subscriber has a Conflator
confl  plant/conflator.ts            coalesce dirty fields per subject; flush every conflationMs (default 250, min 50, tier eod ≥ 60000); latest value always wins
ws     plant/ws-server.ts            {t:'delta', s, seq, st, ts, f} ; bufferedAmount watched → downgrade codes (BUS-04)
client sdk/client/ws-client.ts       validates, updates quote store; detects seq regression → resync
grid   web/grid/cell-registry.ts     imperative textContent update + flash class, batched in one rAF per frame; timer wheel clears flashes
```

Ordering guarantees: within one subject, `seq` is strictly increasing on the wire; a snapshot
carries the `seq` at which it was taken and the client discards deltas with `seq ≤ snapshot.seq`.
Conflation may skip seq values (that is the point) but never reorders and never loses the last value.
Full protocol: API.md §5.

---

## 6. Ingest and scheduler

`ingest/scheduler.ts` is a single-process cooperative scheduler (no external queue) driven by an
injectable `Clock` so tests run it with a virtual clock.

| Job (file under `ingest/jobs/`) | Cadence | Provider | Writes |
| --- | --- | --- | --- |
| `symbology-refresh.ts` | daily 06:00 ET + on demand | openfigi, sec_edgar (`company_tickers.json`) | issuers, issues, instruments, listings, identifiers (bitemporal versions) |
| `universe-symbol-book.ts` | daily | cboe symbol book | search index candidates (not master rows) |
| `cboe-quotes.ts` | 10 s rotating during 04:00–20:00 ET; 5 min off-hours | cboe | plant + ticks + quote_snapshots |
| `cboe-options.ts` | 60 s for chains with active subscribers; daily otherwise | cboe | option_terms (new contracts), option_quotes, plant subjects `o:<id>` |
| `yahoo-intraday.ts` | 60 s for instruments with `b1m` subscribers; 5 min otherwise for universe | yahoo | bars_intraday (1m), plant `b1m` |
| `yahoo-daily.ts` | 17:30 ET daily + backfill on seed | yahoo, stooq (fallback) | bars_daily, corporate_actions (dividends, splits from `events`) |
| `sec-submissions.ts` | hourly for universe CIKs; 8-K atom every 60 s | sec_edgar | filings, news_items (kind='filing') |
| `sec-companyfacts.ts` | daily per CIK (staggered ≤ 10 req/s) | sec_edgar | xbrl_facts (PIT), fin_statements |
| `sec-nport.ts` | monthly + on new N-PORT filing | sec_edgar | index_members (SPY/IVV/QQQ) |
| `treasury-curves.ts` | 18:00 ET daily | ustreasury | curve_points (par, bills), govt_terms (on-the-run bills by CUSIP) |
| `fed-rates.ts` | 08:30 ET daily | nyfed, fed_h15 | econ_observations (SOFR/EFFR/OBFR/TGCR/BGCR, H.15 CMT) |
| `fred-series.ts` | daily per series (rate 1 req/s) | fred | econ_observations with vintage detection |
| `bls-series.ts` | daily (≤ 25 queries/day budget: 5 series) | bls | econ_observations |
| `world-macro.ts` | weekly | worldbank, imf | econ_observations (annual) |
| `fx-eod.ts` | 16:15 CET daily | frankfurter | bars_daily for fx instruments (ECB reference) |
| `fx-intraday.ts` | 60 s | yahoo (`EURUSD=X`) | plant `q:` for fx |
| `news-rss.ts` | 60 s per feed | bbg_rss, fed_rss | news_items + news_entity_links |
| `econ-calendar.ts` | daily | fred (releases calendar HTML), bls (schedule HTML), fed (FOMC calendar HTML) | econ_release_events |
| `short-interest.ts` | twice monthly | finra | short_interest |
| `crypto.ts` | 60 s | coingecko | plant `q:` for crypto |
| `partition-maintenance.ts` | daily 01:00 | — | create next partitions; drop expired per `sources.retention_days` (STOR-07) |
| `access-log-flush.ts` | 1 s | — | access_log batch insert |
| `usage-declarations.ts` | monthly 1st 02:00 | — | usage_declarations |
| `dq-monitors.ts` | 60 s | — | dq_events (stale ticks, divergence, missing close, field population) |

Every job: `run(ctx) → JobResult { fetched, inserted, updated, skipped, errors[], provenanceIds[] }`
recorded in `ingest_runs`. Failures back off exponentially (base 30 s, cap 30 min) and set the
affected md lines' staleness to `stale` after 3 consecutive failures (TERM-12 is a plant concern,
not a UI guess).

---

## 7. Replay harness (FEED-08, QA-02)

Two layers, both deterministic:

1. **Provider replay** (`providers/replay-store.ts`). Every adapter fetch goes through
   `ReplayStore.get(requestKey)`. In `PROVIDER_MODE=replay` a miss throws `REPLAY_MISS` (tests never
   touch the network); in `record` mode a miss fetches and writes; in `live` mode the store is
   bypassed except for recording. Request keys are canonical (`provider|METHOD|url-with-sorted-query|bodyHash`).
   Existing raw files in `fixtures/providers/raw/` are registered by `fixtures/providers/manifest.json`.
   Normalised outputs are committed as goldens under `fixtures/providers/normalised/` and diffed.
2. **Session replay** (`replay/harness.ts`). A recorded session is `fixtures/sessions/<name>/input.ndjson`
   (normalised `QuoteUpdate`s with capture timestamps) + `subscriptions.json` (what clients subscribed,
   with conflation settings). The harness constructs a plant with a `VirtualClock`, feeds updates at
   their capture times, drives the conflators, and captures the outbound WS messages into
   `actual.ndjson`. `replay/diff.ts` compares against `expected.ndjson`; any diff fails the build.
   Because the plant has no hidden time source, output is bit-identical run to run.

---

## 8. Provenance and licence registry (DATA-09, DATA-10)

- `provenance` row per provider response: `{ provenance_id, source_id, endpoint, request_key, response_sha256, raw_ref, fetched_at, source_ts, http_status, trace_id }`.
  Every stored value row carries `provenance_id`. Function payloads carry `meta.provenance[]`
  (deduplicated refs) and the client renders a "source" affordance per value block.
- `sources` (the licence registry) holds per source: display/export/api/redistribution permissions,
  retention days, intrinsic delay, attribution text, rate limits, terms URL. `source_fields` maps
  every field id × asset class to the source that supplies it, so "which fields may this user export"
  is a join, not code. The registry is seeded from `seed/licences.ts` and is the only input to the
  entitlement evaluator's source dimension.

---

## 9. Entitlement evaluation (ENTL-01..06)

```ts
export interface EntitlementRequest { userId: number; firmId: number; instrumentId: number; fieldIds: FieldId[]; tier: Tier; usage: 'display'|'export'|'api'; purpose: string /* function code or route */ }
export interface FieldDecision { fieldId: FieldId; decision: 'allow'|'downgrade'|'deny'; effectiveTier: Tier; reason?: ReasonCode; sourceId: string }
export interface EntitlementDecision { effectiveTier: Tier; fields: FieldDecision[]; downgrades: { code: ReasonCode; message: string }[] }
```

Algorithm (`entitlements/evaluator.ts`), evaluated server-side on every read and every subscribe:

1. Map instrument → md lines → `source_id`s; map each requested field → `source_fields` row (asset class aware) → source + field class.
2. Source rule: `sources.display_allowed/export_allowed/api_allowed` for the usage; `sources.intrinsic_delay_min` bounds the best tier (a 15-min-delayed source can never serve `realtime`).
3. Firm contract: `entitlement_grants` where `subject_kind='firm'` and valid now.
4. User subscription: `entitlement_grants` where `subject_kind='user'`. Effective grant = **intersection** (min tier, AND of usage flags) of user ∩ firm ∩ source (ENTL-02).
5. Quota: `quotas.ts` checks daily unique instruments / monthly points / concurrent subscriptions (API-06).
6. Decision per field: `allow` (requested tier available), `downgrade` (a lower tier is available: `ENTL_TIER_DOWNGRADE`), `deny` (`ENTL_FIELD_DENIED`, `ENTL_SOURCE_NOT_LICENSED`, `ENTL_USAGE_TYPE_DENIED`, `ENTL_QUOTA_EXCEEDED`). Denied fields are **blank with a reason code, never stale** (ENTL-05).
7. Log: one `access_log` row per (user, instrument, field, decision) via the batched async sink (ENTL-04). Purpose = function code / route.
8. Cache: decision inputs cached per (user, source) for 60 s; instrument→source map cached with the plant.

Licences bind to a natural person (ENTL-03): grants are on `user_id`; `sessions` enforce one active
session per user (a second login supersedes and the first WS gets `bye 4409 SESSION_SUPERSEDED`) and
concurrent-use attempts are written to `access_log` with `decision='deny', reason='CONCURRENT_SESSION'`
(SEC-03). Monthly per-source declarations are `SELECT` over `access_log` (ENTL-06, DATA-02) →
`usage_declarations`.

---

## 10. Observability (OPS-07, OPS-03)

- **Trace ids.** `x-trace-id` accepted or generated (`crypto.randomUUID()`) in `observability/trace.ts`;
  bound to the pino child logger, `usage_events.trace_id`, `access_log.trace_id`,
  `provenance.trace_id` (for fetches triggered by a request), WS `subok`/`err` messages and the
  function payload `meta.traceId`. The UI shows it on HELP and on every error; `GET /v1/admin/trace/:id`
  joins logs, access log, provenance and usage events for that id — "why is this number wrong?" in one query.
- **Usage events.** `usage_events` rows for `launch`, `param_change`, `export`, `help`, `navigate`; batched.
- **Metrics.** `GET /metrics` (Prometheus text): plant apply latency histogram, conflator flush sizes,
  WS bufferedAmount, provider fetch latency/errors per source, scheduler lag, DB pool.
- **Data quality (OPS-03, QA-03).** `dq-monitors.ts` writes `dq_events` for stale ticks (no source update > 3× expected during session), cross-source divergence (Cboe vs Yahoo), missing close (no `PX_OFFICIAL_CLOSE` by 16:30 ET), field-population rate drops, message-rate anomalies (poll success rate). `GET /v1/health` and the `sys:status` WS subject expose them (OPS-04).

---

## 11. How requirement tags are honoured

| Tag | Requirements | Mechanism in this design |
| --- | --- | --- |
| **Correctness** | STOR-06, TERM-12, ANAL-08, API-05 | PIT reads keyed on `filed_at` with `known_at` mandatory in the repo API (no "latest" default in backtest paths); staleness is a plant-computed state carried on every WS message and function payload; every engine takes an explicit input set and returns `inputsHash`; exports re-resolve at the payload's `(validAt, knownAt)` through the same resolver and the same `toCsv`. |
| **Regulatory** | DATA-09, ENTL-01, EXEC-01, REG-* | Licence registry is a table joined at decision time; entitlement evaluated in `evaluator.ts` before any repository read and before every WS subscribe; EXEC-* out of scope per BRIEF; REG-01 mechanism = immutable `messages` (no UPDATE/DELETE grants, hash chain) and `access_log` retention. |
| **Blocker / Sales blocker** | DATA-01, SEC-07 | DATA-01 is a contract, not code: the registry records that every v1 source is public/keyless with display-only terms, and the evaluator refuses `redistribution`. SEC-07 out of scope; controls (TLS, WebAuthn, tenant isolation tests) are built so certification can follow. |
| **Cannot be retrofitted** | REF-03 | Every reference/fundamental table is bitemporal from migration 0001; there is no non-bitemporal master to migrate later. |
| **Architecturally load-bearing** | FEED-03 | §3 models are in `core` and used by every adapter, the plant, the SDK and the screens. |
| **High effort** | TERM-08 | Own work package (WP-11) with frame-time budget tests. |
| **Existential / Privacy / Trust** | PORT-07, REG-04, NEWS-08 | Portfolio tables carry `firm_id` and are read only through `withTenant(firmId)` repositories; Postgres row-level security policies on `portfolios/positions/messages`; tenant-isolation integration tests. No LLM-generated numbers exist in v1; the `meta.unavailable[]` mechanism (reason codes) is how a missing consensus number is shown — never a generated one. |
| **Strategic / Decision gate** | MSG-05, SCOPE-05 | Recorded as out of scope with reason in TRACEABILITY.md. |

---

## 12. Runtime topology

Single Node 22 process in dev (`npm run dev` runs server + Vite); in CI, the same server with
`PROVIDER_MODE=replay`. The plant, scheduler and WS server live in the API process (no message
broker). Postgres is the only stateful dependency. Horizontal scaling is out of v1 scope (NFR-03),
but the plant is written against interfaces (`PlantReader`, `SubscriptionSink`) so it can be moved
to its own process later without changing routes.
