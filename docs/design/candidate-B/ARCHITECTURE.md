# ARCHITECTURE — candidate B ("terminal interaction first")

This candidate optimises every trade-off for **sub-second keyboard flow**: keystroke → visual
feedback in one frame, autocomplete resolved locally against a downloaded universe index,
function launch served from an in-memory ticker plant plus warm Postgres reads, and a client
whose live grid and chart never touch the React reconciler on the hot path. Everything else
(bitemporal reference store, provenance, entitlements, replay harness, licence registry) is
built as a first-class mechanism, but it is *shaped* so it never sits on the keystroke path.

All decisions in `docs/BRIEF.md` are taken as fixed. Section numbers below are referenced from
the other candidate-B documents (`DATA_MODEL.md`, `API.md`, `FUNCTIONS.md`, `PROVIDERS.md`,
`CLIENT.md`, `TESTING.md`, `WORKPLAN.md`, `TRACEABILITY.md`).

---

## 1. System overview

```
                     ┌────────────────────────────────────────────────────────────────────┐
                     │  packages/web  (Vite + React 19 + zustand)                          │
   keyboard ───────▶ │  Shell: 4 panels ─ CommandLine ─ Autocomplete(local index)          │
                     │  ScreenRenderer (declarative widgets) ─ LiveGrid(canvas) ─ Chart(canvas)│
                     │  QuoteStore ◀── WsClient (sdk)         RestClient (sdk)              │
                     └──────────┬───────────────────────────────────┬────────────────────┘
                                │ WebSocket /ws/v1                  │ HTTPS /api/v1
                     ┌──────────▼───────────────────────────────────▼────────────────────┐
                     │  packages/server (Fastify 5 + ws)                                   │
                     │  ws/gateway ── Session ── Conflator ── Fanout                        │
                     │  http/routes ── FunctionRunner ── EntitlementService ── AccessLog    │
                     │  plant/TickerPlant (in-memory composite QuoteState per instrument)   │
                     │  ingest/Scheduler ── providers/* (fetch→raw→normalise→provenance)    │
                     │  replay/ReplayStore (record | replay)   search/UniverseSnapshot      │
                     └──────────┬───────────────────────────────────┬────────────────────┘
                                │ pg (Drizzle, SQL migrations)      │ HTTP (rate-limited, cached)
                     ┌──────────▼──────────┐              ┌─────────▼──────────────────────┐
                     │ Postgres 14         │              │ OpenFIGI · SEC EDGAR · Cboe     │
                     │ bloomberg_dev/_test │              │ Yahoo · FRED · NY Fed · H.15    │
                     │ pg_trgm, btree_gist │              │ Treasury · frankfurter · BLS    │
                     │ pgcrypto, uuid-ossp │              │ World Bank · IMF · FINRA · Fed  │
                     └─────────────────────┘              └────────────────────────────────┘
                                              packages/core (pure): ids, calendars, day counts,
                                              analytics, formula language, command grammar,
                                              function manifests, field dictionary source.
                                              packages/sdk: REST/WS client + wire types + registry.
```

Single server process in v1 (Fastify HTTP + `ws` on the same port, plant and scheduler in-process).
The process boundaries that matter for later scale-out are already module boundaries:
`plant/`, `ingest/`, `ws/` and `http/` only communicate through typed interfaces
(`PlantBus`, `ProviderRegistry`, `EntitlementService`) so any of them can be moved to a
separate process behind the same interface without touching callers.

---

## 2. Package boundaries

| Package | npm name | May import | Must not import | Role |
| --- | --- | --- | --- | --- |
| `packages/core` | `@terminal/core` | `zod` only | anything with IO (`pg`, `fastify`, `react`, `ws`, `node:fs`) | Pure domain: identifiers, calendars, day counts, analytics engines, formula language, command grammar + ranking, function manifests, field dictionary source, corporate-action adjustment maths, quote model, CSV serialisers. 100 % unit-testable, runs in browser and Node. |
| `packages/sdk` | `@terminal/sdk` | `@terminal/core`, `zod` | server/web internals | Wire schemas (zod) for REST + WS, typed `RestClient`, `WsClient` (resubscribe, seq tracking, conflation preference), field dictionary (generated JSON + types), function registry re-export. Used by the web client *and* external JS users (API-03 JavaScript, API-05 identical values). |
| `packages/server` | `@terminal/server` | `core`, `sdk`, `fastify`, `ws`, `pg`, `drizzle-orm`, `pino` | `react` | Fastify app, Drizzle schema + SQL migrations, providers, ticker plant, WS gateway, function resolvers, entitlements, access log, scheduler, replay store, seed. |
| `packages/web` | `@terminal/web` | `core`, `sdk`, `react`, `zustand` | `pg`, `fastify`, server internals | Terminal client: shell, command line, panels, screens, live grid, chart engine. |
| `packages/e2e` | `@terminal/e2e` | `@playwright/test` | — | End-to-end terminal flows against a server started in `PROVIDER_MODE=replay`. |
| `fixtures/` | — | — | — | Raw provider captures, replay store, golden datasets, seed data, plant replay sessions. |

Dependency direction is strictly `core ← sdk ← {server, web}`; `e2e` depends on nothing at
compile time. Enforced by `eslint-plugin-import` `no-restricted-paths` rules in
`eslint.config.js` (owned by WP-01) and by each package's `tsconfig.json` `references`.

---

## 3. Module list per package (file paths)

### 3.1 `packages/core/src`

| Path | Contents |
| --- | --- |
| `index.ts` | Barrel. |
| `ids/figi.ts`, `ids/isin.ts`, `ids/cusip.ts`, `ids/sedol.ts` | Format validators + check digits (ISIN Luhn, CUSIP mod-10 "double-add-double", SEDOL weighted). |
| `ids/securityKey.ts` | `SecurityKey` = `{ticker, exchCode?, sector}`; `formatSecurityKey`, `parseSecurityKey`, sector ↔ asset-class map. |
| `ids/occ.ts` | OCC option symbol parse/format (`AAPL260916C00245000` → underlying, expiry, C/P, strike). |
| `calendars/calendar.ts` | `Calendar` interface, `isBusinessDay`, `adjust(date, bdc)`, `addTenor`, `combine(cal1, cal2)` (REF-06 combination rules: union of holidays). |
| `calendars/nyse.ts`, `calendars/sifma.ts`, `calendars/target2.ts`, `calendars/weekend.ts` | Rule-based holiday generators 1990–2040 (NYSE incl. Good Friday / Juneteenth from 2022; SIFMA early closes as half-days; TARGET2 for EUR). |
| `daycount/index.ts` | `ACT_360`, `ACT_365F`, `ACT_ACT_ISDA`, `ACT_ACT_ICMA(freq)`, `THIRTY_360_US`, `THIRTY_E_360`; `yearFraction(dc, d1, d2, opts)`. |
| `analytics/bond/price.ts` | Street-convention price↔yield (semiannual, ACT/ACT ICMA), accrued, odd first/last coupon, T-bill discount/BEY/MMY. |
| `analytics/bond/risk.ts` | Macaulay/modified duration, convexity, DV01, key-rate durations (bump-and-reprice on a curve). |
| `analytics/curve/bootstrap.ts` | Deposits/OIS/par-swap bootstrap to discount factors; interpolation (linear on zero, log-linear on DF, monotone-convex). |
| `analytics/curve/treasuryPar.ts` | Par-curve → zero/forward via bootstrapping semiannual par yields on CMT tenors. |
| `analytics/curve/ois.ts` | SOFR OIS pricing (daily compounding in arrears, payment lag), SWPM engine. |
| `analytics/curve/policyPath.ts` | WIRP engine: implied overnight path from bill/OIS curve (forward-rate stepping at FOMC dates). |
| `analytics/options/bsm.ts` | BSM/Black-76 price + full greeks; implied vol (Newton with bisection fallback). |
| `analytics/options/tree.ts` | CRR binomial, trinomial; American exercise. |
| `analytics/options/mc.ts` | Monte Carlo with antithetic + control variate; seeded PRNG (`xoshiro128**`) for reproducibility. |
| `analytics/options/surface.ts` | Chain → smile per expiry, SVI fit, arbitrage checks (calendar/butterfly), interpolation. |
| `analytics/stats/index.ts` | Returns (simple/log), annualised vol, correlation, beta, OLS regression, drawdown, Sharpe/Sortino/IR; conventions documented in-file (ANAL-07). |
| `analytics/portfolio/attribution.ts`, `exposure.ts`, `var.ts` | Brinson–Fachler, sector/factor exposures, tracking error, historical/parametric VaR. |
| `adjust/corporateActions.ts` | `adjustmentFactors(actions, policy)` → per-date cumulative factors for price/volume; policies `unadjusted | price | total_return` (REF-09). |
| `formula/lexer.ts`, `parser.ts`, `evaluator.ts` | Formula language (CHRT-07): security refs, arithmetic, `MA(x,n)`, `RATIO`, `SPREAD`, baskets. |
| `command/tokenizer.ts`, `command/grammar.ts`, `command/rank.ts`, `command/index.ts` | Command grammar (TERM-01), candidate generation, ranking (TERM-02), local universe index structures. |
| `functions/manifest.ts` | `FunctionManifest`, `CsvSpec`, `LiveSpec`, `HelpSpec`, `ParamGrammar` types. |
| `functions/registry.ts` | `FunctionRegistry` (code/alias lookup, by tier, by asset class). |
| `functions/manifests/<CODE>.ts` | One manifest per catalogue function (see FUNCTIONS.md). |
| `functions/csv.ts` | `toCsv(manifest, payload, params)` → `CsvDocument`; RFC 4180 serialiser. |
| `quote/model.ts` | `Instrument`, `Listing`, `Quote`, `QuoteDelta`, `StalenessTier`, `SessionState`, `LatencyTier` (FEED-03/05). |
| `quote/staleness.ts` | `stalenessOf(quote, now, expectedIntervalMs, session)`. |
| `fields/dictionary.ts` | Source of truth for the field dictionary (API-07): id, label, type, unit, fieldClass, sourceId, updateFreq, example. Generated to `packages/sdk/src/fields.json`. |
| `time/` | `TradingDayIndex` (calendar-aware x-axis mapping for charts), tenor parsing (`1M`, `10Y`). |

### 3.2 `packages/sdk/src`

| Path | Contents |
| --- | --- |
| `wire/rest.ts` | zod schemas: `ErrorEnvelope`, `DataRequest`, `DataResponse`, `FunctionRunRequest/Response`, workspace/watchlist/portfolio/message/alert DTOs. |
| `wire/ws.ts` | zod schemas for every WS message (`ClientMessage`, `ServerMessage`), reason codes. |
| `client.ts` | `RestClient` (fetch wrapper, trace ids, error envelope → typed errors, ETag cache for universe snapshot). |
| `ws.ts` | `WsClient`: connect/auth, `subscribe(subjects, fields)`, refcounting, per-subject seq tracking, gap → resubscribe, reconnect with resync, conflation preference, slow-consumer notices. |
| `fields.json`, `fields.ts` | Generated field dictionary + typed accessors. |
| `functions.ts` | Re-export of `@terminal/core` registry + `runFunction(code, params)` typed by manifest. |
| `index.ts` | Barrel. |

### 3.3 `packages/server/src`

| Path | Contents |
| --- | --- |
| `index.ts` | Process entry: load config, run migrations check, build app, start plant + scheduler, listen. |
| `app.ts` | `buildApp(cfg): FastifyInstance` — plugins (pino, cookie, cors, rate-limit, trace id), routes, WS gateway. Used by tests. |
| `config.ts` | zod-validated env: `DATABASE_URL`, `PROVIDER_MODE`, `REPLAY_DIR`, `SEC_USER_AGENT`, `OPENFIGI_API_KEY?`, `SESSION_SECRET`, `PORT`, `CONFLATE_MS_DEFAULT`, `SEED_SYNTHETIC`. |
| `db/client.ts` | `pg.Pool` + Drizzle instance; `withTx`. |
| `db/schema/*.ts` | Drizzle tables mirroring `DATA_MODEL.md` (one file per domain: `reference.ts`, `timeseries.ts`, `fundamentals.ts`, `econ.ts`, `news.ts`, `curves.ts`, `users.ts`, `entitlements.ts`, `workspace.ts`, `messaging.ts`, `ops.ts`). |
| `db/bitemporal.ts` | `asOf(table, validAt, knownAt)` predicate builder, `bitemporalInsert`, `bitemporalClose`, `tstzrange` custom type. |
| `db/partitions.ts` | `ensurePartitions(table, horizonMonths)` for range-partitioned tables. |
| `drizzle/migrations/NNNN_*.sql` (package root) | Committed SQL migrations; `drizzle.config.ts`. |
| `db/seed/index.ts`, `db/seed/*.ts` | Offline seed from fixtures (universe, memberships, bars, rates, curves, news, users, entitlements, licence registry). |
| `http/trace.ts` | `x-trace-id` plugin: accept client id or mint ULID; child logger; response header. |
| `http/errors.ts` | `AppError` hierarchy → error envelope. |
| `http/auth/session.ts`, `http/auth/webauthn.ts`, `http/auth/password.ts` | Cookie sessions (pgcrypto-hashed tokens), WebAuthn registration/assertion, password fallback for dev. |
| `http/routes/*.ts` | `auth`, `search`, `universe`, `data`, `functions`, `results`, `fields`, `workspaces`, `watchlists`, `portfolios`, `messages`, `alerts`, `entitlements`, `usage`, `help`, `status`. |
| `ws/gateway.ts` | Upgrade handling, session binding, message dispatch. |
| `ws/session.ts` | `WsSession`: subscriptions, conflator, quota, slow-consumer state machine. |
| `ws/conflation.ts` | `Conflator`: per-subject latest-value merge + timed flush. |
| `ws/protocol.ts` | Encode/decode via `@terminal/sdk` schemas; reason codes. |
| `plant/tickerPlant.ts` | Composite `QuoteState` map, `apply(update)`, `snapshot(subject)`, `subscribe(subject, listener)`. |
| `plant/composite.ts` | BUS-05 composition rules across md lines. |
| `plant/staleness.ts` | Staleness clock per subject; emits `stale` transitions. |
| `plant/policyTier.ts` | BUS-06: derives `delayed`/`eod` views from the composite state. |
| `plant/subjects.ts` | Subject grammar (`q:<iid>`, `bar1m:<iid>`, `chain:<iid>`, `news:<topic>`, `rate:<code>`, `alerts:<uid>`, `room:<rid>`). |
| `providers/http.ts` | `HttpClient` with modes live/record/replay, per-host token buckets, ETag/TTL cache, retries, circuit breaker. |
| `providers/types.ts` | `ProviderAdapter`, `RawRecord`, `Normalised<T>`, `Provenance`. |
| `providers/registry.ts` | Adapter registry + licence entries. |
| `providers/<name>/adapter.ts`, `providers/<name>/parse.ts` | One directory per provider (see PROVIDERS.md). |
| `ingest/scheduler.ts` | Cron-like scheduler, per-job concurrency 1, jitter, backoff, `ingest_runs` bookkeeping. |
| `ingest/jobs/*.ts` | Job definitions (`quotes.poll`, `bars.intraday`, `bars.daily`, `symbology.refresh`, `news.rss`, …). |
| `ingest/activeUniverse.ts` | Computes the poll set from subscriptions + watchlists + index members + recent views. |
| `replay/store.ts` | Replay store file format read/write, key derivation. |
| `replay/session.ts` | Plant replay harness: feed recorded responses through adapters + plant with a virtual clock; capture published stream; diff. |
| `entitlements/service.ts` | `EntitlementService.check()` and `checkMany()`; cache with version bump. |
| `entitlements/licenceRegistry.ts` | Loads `licence_registry` + `field_licence`; `permits(sourceId, usage)`. |
| `entitlements/accessLog.ts` | Batched async writer (`access_log`), 1 s / 500-row flush, backpressure-safe. |
| `entitlements/declarations.ts` | Monthly per-source declarations query (ENTL-06). |
| `functions/context.ts` | `ResolveContext`: db, plant, providers (read-through cache), entitlements, user, trace, clock, `asOf`. |
| `functions/runner.ts` | `runFunction(code, params, ctx)`: manifest lookup, security resolution, param parse, entitlement pre-check, resolve, provenance/staleness stamping, result cache (`resultId`), usage event. |
| `functions/security.ts` | `SecurityResolver`: `SecurityKey`/identifier → `Instrument` (bitemporal, as-of). |
| `functions/<CODE>/resolve.ts` | One resolver per function (variants by asset class inside). |
| `functions/index.ts` | **Generated** by `scripts/gen-function-index.ts` from the directory listing (never hand-edited). |
| `search/snapshot.ts` | Builds the compressed universe snapshot (instruments + functions + people + topics) with ETag. |
| `search/rank.ts` | Server-side ranking (same `@terminal/core` ranker) for `/search` fallback. |
| `news/ingest.ts`, `news/entityLink.ts` | RSS/Atom normalisation, entity resolution (precision-first rules). |
| `messaging/service.ts` | Rooms, messages (append-only, hash chain), surveillance lexicon, legal hold. |
| `alerts/engine.ts` | Alert evaluation on plant deltas / news / calendar; delivery in-app via WS `alerts:<uid>`. |
| `portfolio/service.ts` | Upload/parse positions, reconciliation, analytics glue. |
| `usage/events.ts` | Batched `usage_events` writer. |
| `quality/monitor.ts` | OPS-03 data-quality signals (stale-tick, cross-source divergence, missing close). |
| `reconcile/index.ts` | QA-03 Cboe vs Yahoo close reconciliation job. |
| `observability/logger.ts`, `observability/metrics.ts` | pino config, in-process counters/histograms, `/api/v1/status`. |

### 3.4 `packages/web/src`

| Path | Contents |
| --- | --- |
| `main.tsx`, `App.tsx` | Bootstrap, session check, workspace load, shell mount. |
| `shell/PanelGrid.tsx`, `shell/Panel.tsx` | Layout (1/2/4 panels), per-panel frame stack, focus. |
| `shell/CommandLine.tsx`, `shell/Autocomplete.tsx` | Command input, candidate list, key handling. |
| `shell/keymap.ts` | Global key bindings (TERM-07), key-routing (typing anywhere goes to the command line). |
| `shell/StatusBar.tsx` | Connection, conflation, staleness legend, trace id, quotas. |
| `shell/help/HelpOverlay.tsx` | HELP ×1 overlay; ×2 ticket form. |
| `command/localIndex.ts` | Loads universe snapshot (IndexedDB cache), builds prefix/word/trigram indexes, MRU. |
| `command/dispatch.ts` | Candidate → panel action; context rules (TERM-03). |
| `state/session.ts`, `state/panels.ts`, `state/workspace.ts`, `state/quotes.ts`, `state/subscriptions.ts`, `state/usage.ts` | zustand stores (see CLIENT.md). |
| `rt/wsBridge.ts` | `WsClient` → `QuoteStore`, refcounted subscriptions, gap handling UI. |
| `screen/ScreenRenderer.tsx`, `screen/widgets/*.tsx` | Declarative widget set: `Grid`, `KeyValue`, `Chart`, `Tabs`, `Form`, `Text`, `Split`, `List`, `Table`, `Sparkline`, `Badge`. |
| `grid/GridModel.ts`, `grid/CanvasGridRenderer.ts`, `grid/DomGridRenderer.ts`, `grid/LiveGrid.tsx`, `grid/columns.ts`, `grid/format.ts` | Live grid (TERM-08). |
| `chart/engine/*.ts`, `chart/Chart.tsx` | Canvas chart engine (CHRT-01..07). |
| `functions/<CODE>/Screen.tsx` | One screen per function; `functions/index.ts` generated. |
| `export/csv.ts` | PRINT → server export endpoint → file save via browser download. |
| `theme/tokens.css`, `theme/colors.ts`, `theme/type.ts` | Density type stack + semantic colours (TERM-11). |
| `formula/` | Formula editor glue (`<...>` security slot). |

### 3.5 `packages/e2e`

`playwright.config.ts` (channel `chrome`), `tests/*.spec.ts`, `fixtures/serverProcess.ts` (spawns server in replay mode against `bloomberg_test`).

### 3.6 Root

`package.json` (workspaces, scripts: `dev`, `build`, `test`, `test:live`, `db:migrate`, `db:seed`, `db:reset`, `gen:functions`, `gen:fields`, `fixtures:import`), `tsconfig.base.json`, `eslint.config.js`, `vitest.workspace.ts`, `scripts/*.ts`.

---

## 4. Request lifecycle: keystroke → command parse → function resolve → data → screen

Budget (NFR table): keystroke feedback < 16 ms; autocomplete < 80 ms p95; Tier-1 launch < 500 ms p95.

```
t=0      keydown in <CommandLine> (panel P)
t<1ms    input state updated synchronously (uncontrolled input + zustand transient set)
t<4ms    core/command: tokenize → candidate parses → rank against localIndex (prefix arrays,
         word index, MRU). Returns ≤ 12 ranked Candidates. No network, no debounce.
t<16ms   <Autocomplete> re-renders (memoised rows; virtual list) — one frame.
GO       Enter: take candidates[0] (or selected row). dispatch(P, candidate):
           - security-only → reload P.function with new security (TERM-03)
           - function-only → apply to P.security (or error 'NO SECURITY LOADED' if required)
           - full command → push Frame{security, fn, params} onto P.history
         usage.push({type:'function.launch', code, params, traceId})           (FUNC-04)
         traceId = ulid()  (client-minted, sent as x-trace-id)                  (OPS-07)
t<20ms   Panel renders the function's Screen with `payload: undefined` + skeleton, or the
         cached payload if (code, securityKey, params) hit the panel LRU (stale-while-revalidate).
t<25ms   sdk.RestClient.post('/api/v1/functions/DES/run', {security, params}, {traceId})
server   http/trace → auth (session cookie) → zod parse (manifest.params) →
         SecurityResolver (as-of now; identifiers → instrument; 1 indexed query, ~1 ms) →
         EntitlementService.checkMany(user, fieldClasses × instrument × tier=delayed × usage=display)
         (cached per user; version bump on entitlement change) →
         resolver: plant.snapshot(q:<iid>) (in-memory), db reads (indexed, ≤ 3 round-trips for
         Tier-1), provider read-through cache for rarely-needed data (TTL) →
         stamp {provenance[], staleness, asOf, tier} → resultCache.put(resultId, payload, 10 min) →
         accessLog.enqueue(rows) (async) → usage.enqueue → 200 {resultId, payload, meta}
t<150ms  Screen re-renders with payload. manifest.live(params, payload) → subjects/fields →
         subscriptions.acquire(subjects) (refcounted; one WS) → snapshots arrive → cells flash.
```

Every hop carries the same `traceId`: client log ring buffer, `x-trace-id` header, server child
logger, `usage_events.trace_id`, `access_log.trace_id`, `result.meta.traceId`, and WS
`sub.t`. "Why is this number wrong?" is answered by `traceId` → resolver → `provenance` rows →
`replay_key` → the recorded raw response.

---

## 5. Real-time lifecycle: provider poll → normaliser → plant → conflated WS → grid flash

```
Scheduler(job quotes.poll, every 10 s, jitter ±1 s)
  │  activeUniverse(): subscribed subjects ∪ watchlists of connected users ∪ WEI/monitor sets,
  │  ordered by (subscriber count desc, last poll asc); capped by provider token bucket.
  ▼
providers/cboe/adapter.fetchQuote(sym)          (HttpClient: token bucket 5 rps, TTL 8 s)
  │  RawRecord{url, status, body, fetchedAt}  → ReplayStore.record() if PROVIDER_MODE=record
  ▼
providers/cboe/parse.normaliseQuote(raw) → QuoteUpdate {
     iid, fields:{PX_LAST, PX_BID, PX_ASK, BID_SIZE, ASK_SIZE, PX_OPEN, PX_HIGH, PX_LOW,
     PX_PREV_CLOSE, PX_VOLUME, IVOL_30D, LAST_TRADE_TS, SEQNO},
     ts:{src: last_trade_time(ET→epoch ms), cap: fetch end, pub: 0}, srcSeq: seqno,
     tier:'delayed', prov: Provenance }
  ▼
plant.apply(update)
  │  state = states.get(iid) ?? new QuoteState(iid)
  │  if update.srcSeq <= state.srcSeq → touch(cap) only (refresh staleness clock), no publish
  │  merge fields (composite rules from plant/composite.ts), derive CHG_NET_1D/CHG_PCT_1D/TICK
  │  session state from calendar + timestamps (pre/open/closed/post/halt unknown)
  │  state.seq += 1; ts.pub = now; changed = diff(prev, next)
  ▼
fanout.publish(subject 'q:<iid>', delta{seq, fields: changed, ts})
  │  for each WsSession subscribed to subject (field-filtered per subscription, BUS-02):
  │     session.conflator.merge(subject, delta)   // latest value per field wins; seq = latest
  ▼
Conflator.flush() every conflateMs (default 250 ms; client may request 50–2000 ms):
  │  if ws.bufferedAmount > HIGH_WATER (1 MiB): level++ → conflateMs ×2 (max 2000), notify {op:'slow'}
  │  if level > 3 or bufferedAmount > 8 MiB: drop to snapshot-only, then close(4008 SLOW_CONSUMER)
  │  else send {op:'batch', msgs:[{op:'delta', s, seq, f, ts}...]}   (one frame per flush)
  ▼
web/rt/wsBridge: for each delta → QuoteStore.apply(subject, delta):
  │  if delta.seq !== prev.seq + 1 → mark subject GAP → ws.resubscribe(subject) (snapshot heals)
  │  store fields into typed FieldMap; compute staleness locally from ts + expected interval
  ▼
grid/GridModel.onQuote(iid, changedFields): mark cells dirty with direction (up/down/flat)
  ▼
CanvasGridRenderer rAF loop: repaint only dirty cells (clip rect), flash colour decays over
700 ms via 3 keyframes; full repaint only on scroll/sort/resize. No React on this path.
```

Latest-value guarantee (BUS-03): the conflator stores the *merged* delta per subject, so if 40
updates arrive in one interval the flushed message carries every field's most recent value and the
highest seq; nothing is dropped, only intermediate values are skipped. The client's seq check
tolerates conflation because the server sets `seq` to the last merged seq and includes
`skipped: n` so the client accepts `seq > prev` when `skipped` covers the gap.

Staleness (TERM-12): the plant emits `{op:'stale', s, tier}` on transitions
(`live → aging → stale → dead`, or `closed`). The client also computes it locally every second
from the last `ts.cap` so a dead WebSocket cannot leave a "live" number on screen.

---

## 6. Ingest / scheduler design

`ingest/scheduler.ts` runs jobs defined in `ingest/jobs/*.ts`:

```ts
export interface IngestJob {
  name: string;                       // 'quotes.poll'
  schedule: string | { everyMs: number; jitterMs?: number; marketHoursOnly?: boolean };
  provider: ProviderId;               // for circuit breaker + rate budget
  run(ctx: JobContext): Promise<JobResult>;   // JobResult { fetched, upserted, skipped, errors[] }
  timeoutMs: number;
  priority: 1 | 2 | 3;                // 1 = subscribed real-time, 3 = weekly reference
}
```

Rules: one running instance per job; failures recorded in `ingest_runs` with error class; exponential
backoff (2^n × 5 s, max 10 min); per-provider circuit breaker (open after 5 consecutive failures,
half-open probe after 60 s); provider token buckets are shared between scheduler and on-demand
read-through calls (scheduler uses at most 70 % of a bucket so interactive requests are never starved).
Full schedule table: PROVIDERS.md §4.

Read-through cache: function resolvers never call providers directly; they call
`ctx.providers.get(kind, key, {maxAgeMs})` which returns DB/plant data if fresh enough, else
fetches through the adapter (respecting the same buckets) and persists. This keeps the
keystroke path from ever depending on a slow provider (Treasury XML ≈ 18 s is only ever fetched by
the scheduler; the resolver reads the `curve_points` table).

---

## 7. Replay harness (FEED-08, QA-02)

Two layers:

1. **Provider replay store** (`replay/store.ts`, format in PROVIDERS.md §6). `HttpClient` in
   `replay` mode resolves every request to a recorded file by deterministic key; a miss throws
   `ReplayMissError` (tests fail loudly, never silently fetch). `record` mode writes through.
   `npm test` runs with `PROVIDER_MODE=replay`.
2. **Plant session replay** (`replay/session.ts`). A session directory
   `fixtures/replay-sessions/<name>/` holds an ordered `events.jsonl` (`{tOffsetMs, provider,
   replayKey}`) plus the referenced replay files. `ReplaySession.run({speed:'max'|1})` drives the
   real adapters + plant with a virtual clock and records every published delta into
   `out/<name>.published.jsonl`. `diffPublished(a, b)` compares two runs (seq, fields, ts.src)
   ignoring `ts.cap/pub`; any diff fails `test/replay/sessions.test.ts`. Release candidates run all
   sessions (QA-02).

---

## 8. Provenance and licence registry (DATA-09, DATA-10)

- Every adapter fetch creates one `provenance` row: `source_id`, `replay_key`, `request_url`,
  `request_hash`, `response_hash` (sha256), `fetched_at`, `source_ts` (provider's own timestamp,
  e.g. Cboe `timestamp`, Yahoo `meta.regularMarketTime`), `http_status`, `licence_id`,
  `adapter_version`. Every stored value row references `prov_id`. In-memory `QuoteState` carries the
  latest `prov` per field group.
- Function payloads carry `meta.provenance: ProvenanceRef[]` and each screen section declares which
  ref it draws from; the client shows the source footer and `Ctrl+I` on any cell opens the provenance
  panel (source, fetched-at, source-ts, licence terms, replay key).
- `licence_registry` is a bitemporal table listing each source's terms (display/non-display/
  derived/redistribution/export/api permissions, delay, retention days, attribution text, contract
  ref, URL). `field_licence` maps every `field_id` (from the dictionary) to `(source_id,
  licence_id, field_class)`. `EntitlementService` and the export path read only from these tables;
  retention (STOR-07) is enforced by `ingest/jobs/retention.purge` reading `retention_days`.

---

## 9. Entitlement evaluation (ENTL-01..06)

`EntitlementService.check(user, q)` where `q = {instrumentId, fieldClass, tier, usage}`:

1. `fieldClass → sourceId` via the field dictionary (a payload may mix classes; `checkMany` batches).
2. Licence gate: `licence_registry.permits(sourceId, usage)` (display / export / api / non_display).
   Fail → `LICENCE_FORBIDS_USAGE`.
3. Firm gate: highest tier granted to `user.firm` for `(sourceId, fieldClass)` in `entitlements`
   (valid as-of now). None → `NO_FIRM_ENTITLEMENT` (blank + reason).
4. User gate: user's own row, intersected with the firm's (`min(tier)`). Default seed grants every
   user `delayed` for all public sources (BRIEF §5.6).
5. Source ceiling: a source that only publishes delayed/EOD data can never yield `realtime`
   (`TIER_UNAVAILABLE_SOURCE_DELAYED`), and `eod` sources cannot yield `delayed` (`TIER_EOD_ONLY`).
6. Result `{granted, effectiveTier, reason?}`. A downgrade is *always* explicit: the WS sends
   `{op:'downgrade', s, tier, reason}`, REST includes `meta.entitlement[]`, and CSV export refuses
   with `LICENCE_FORBIDS_USAGE` rather than exporting a subset silently.
7. Every granted access is logged (`access_log`) with `usage` ∈ display/export/api and `purpose`
   (function code or `api`). Batched, async, never on the response path (ENTL-04).
8. Natural-person binding (ENTL-03): sessions are per user; a new login from a different device
   revokes the previous session (`SESSION_SUPERSEDED`), WS connections are torn down with close code
   4003; concurrent-use attempts are counted in `sessions.superseded_count` for audit.
9. Declarations (ENTL-06): `GET /api/v1/usage/declarations?month=2026-09` runs
   `entitlements/declarations.ts` — distinct users per source × field class × tier from `access_log`.

Client-side filtering never happens: the server strips fields it will not grant and returns the
reason code in their place (`{v:null, r:'NO_FIRM_ENTITLEMENT'}`).

---

## 10. Observability (OPS-07)

- **Trace ids**: ULID minted by the client per command (`cmd_…`) or by the server for API calls;
  header `x-trace-id`; WS `t` correlation field; present in pino logs, `usage_events`, `access_log`,
  `ingest_runs` (job-run trace), `result.meta`.
- **Logs**: pino JSON to stdout; levels per module; request log with latency histogram buckets.
- **Metrics** (`/api/v1/status`, dev-only JSON): plant updates/s, publish/s, per-session conflation
  level, provider bucket occupancy, circuit breaker states, scheduler lag, DB pool stats, p50/p95
  per route, WS sessions, subscriptions. Playwright perf tests read the same endpoint.
- **Usage events** (`usage_events`): `function.launch | function.param | function.export |
  function.page | function.help | cmd.parse | panel.switch | ws.slow | ws.resync`. The roadmap
  query `SELECT function_code, count(*) FROM usage_events WHERE ts > now()-interval '30 days'
  GROUP BY 1` is the FUNC-04 deliverable.
- **Data-quality signals** (`data_quality_events`): stale-tick (no change for N × interval during
  session), cross-source divergence (Cboe close vs Yahoo close > 0.5 %), missing close by 17:30 ET,
  field population rate per adapter run, message-rate anomaly (poll returns 0 changes for > 10 min
  during session).

---

## 11. How the requirement tags are honoured

| Tag | Mechanism in this design |
| --- | --- |
| **[Correctness]** STOR-06 | All fundamentals reads take `knownAt`; `xbrl_facts` is keyed on `filed_at` and the PIT query picks the latest filing ≤ `knownAt` per period. Tested by `fundamentals.pit.test.ts` (restated value invisible before its `filed_at`). |
| **[Correctness]** TERM-12 | `Quote.stale` is part of the wire model; the client recomputes staleness every second; every widget renders staleness via colour + glyph; a value with no `ts.cap` cannot render as live. |
| **[Correctness]** ANAL-08 | Every engine takes an explicit `inputs` object and `valuationTs`, returns `{value, inputs, version}`; PRNG-seeded MC; golden tests pin outputs. |
| **[Correctness]** API-05 | Screen, CSV and API all consume the same cached `payload` by `resultId`; `toCsv` lives in `core` and is the only serialiser. |
| **[Regulatory]** DATA-09, ENTL-01 | Licence registry + `field_licence` are the only inputs to entitlement decisions; evaluation is server-side in `runner.ts`, `ws/session.ts` and `results.ts`. |
| **[Regulatory]** MSG-02, REG-01 | `messages` is append-only (no UPDATE/DELETE grants to the app role), hash-chained (`prev_hash`, `hash`), with `legal_holds` and `surveillance_hits`. |
| **[Regulatory]** EXEC-01, REG-* | Execution out of scope (BRIEF non-goal); registry/policy items recorded as gaps in TRACEABILITY.md. |
| **[Blocker]** DATA-01 | Licensing cannot be coded; the registry records the public-source terms we actually operate under and drives downgrades. |
| **[Architecturally load-bearing]** FEED-03 | `core/quote/model.ts` is the single normalised model; every adapter emits `QuoteUpdate`/`Bar`/`Trade` in that model; the plant, WS, grid and chart consume nothing else. |
| **[Cannot be retrofitted]** REF-03 | Bitemporal columns + exclusion constraints on every reference/fundamentals table from migration 0001. |
| **[High effort]** TERM-08 | Dedicated work package (WP-07) with its own perf harness. |
| **[Existential]** PORT-07 | Portfolio tables carry `firm_id`; Postgres row-level security policies on `portfolios/positions/lots` keyed by `current_setting('app.firm_id')`; tenant isolation tests. |
| **[Trust]** NEWS-08 | No LLM summarisation in v1; `news_items.machine_generated` column exists and the renderer would style it separately; unused. |

---

## 12. Runtime topology and startup

`npm run dev` → `concurrently` starts `server` (`tsx watch`, port 8080) and `web` (Vite, 5173, proxy
`/api` + `/ws`). Server startup order: config → migrations check (fail if pending) → build app →
load licence registry + field dictionary → warm plant from `quote_ticks` last snapshot per
instrument (so the screen is never blank) → start scheduler → listen. Shutdown: stop scheduler,
flush access/usage buffers, close WS with 1001, drain pool.

`PROVIDER_MODE=replay` (tests, e2e, offline demo) makes the same process serve exclusively from
fixtures; `record` captures new fixtures while behaving as `live`.
