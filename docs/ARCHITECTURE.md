# ARCHITECTURE — final system architecture

This is the binding architecture for the terminal clone described in [BRIEF.md](./BRIEF.md) and
[REQUIREMENTS.md](./REQUIREMENTS.md). It merges the three candidate designs under
`docs/design/candidate-{A,B,C}/`: the data spine and bitemporal machinery come mostly from A, the
keystroke path, local autocomplete index and function-manifest contract from B, and the ticker-plant
sequencing, conflation and backpressure rules from C. Where the candidates disagreed the choice is
recorded in §15 with a one-line reason. Companion documents that must agree with this one:
`DATA_MODEL.md` (full DDL), `API.md` (every route and WS message), `FUNCTIONS.md` (manifests),
`PROVIDERS.md` (adapters, schedules, licence entries), `TESTING.md`, `TRACEABILITY.md`.

Design rule that resolves every trade-off below: **a number exists once.** It is produced by one pure
engine in `@terminal/core` or one data service in `@terminal/server`; it travels with its provenance
id, its `(validAt, knownAt)` pair, its tier and its staleness state; it is formatted by one formatter;
and the terminal screen, the REST API, the WebSocket feed and the CSV export are four views of that
same value (API-05, FUNC-03, ANAL-08, DATA-10, TERM-12).

---

## 1. System overview and dependency direction

```
                    ┌───────────────────────────────────────────────────────────────────────┐
   keyboard ──────▶ │ packages/web  @terminal/web  (Vite 8, React 19, zustand 5)              │
                    │  shell: 4 panels · CommandLine · Autocomplete (local universe index)    │
                    │  ScreenRenderer (declarative widgets) · LiveGrid (DOM, imperative)      │
                    │  ChartCanvas (custom canvas renderer)                                   │
                    │  all IO through @terminal/sdk — web never calls fetch/WebSocket itself  │
                    └───────────────┬────────────────────────────────────┬──────────────────┘
                                    │ HTTPS /api/v1  (zod, x-trace-id)    │ WS /ws/v1 (snap/delta, seq, conflation)
                    ┌───────────────▼────────────────────────────────────▼──────────────────┐
                    │ packages/server  @terminal/server  (Fastify 5.12 + ws 8, one process)   │
                    │                                                                         │
                    │  http/routes ─▶ entitlements/evaluator ─▶ functions/runner ─▶ data/*    │
                    │        │ access_log (batched)      │ usage_events        │ asOf(validAt,knownAt)│
                    │        ▼                            ▼                     ▼ adjust-on-read      │
                    │  ws/gateway ─ ws/session ─ ws/conflator ◀── plant/tickerPlant (composite   │
                    │                                            QuoteState per subject, seq)   │
                    │  ingest/scheduler ─▶ ingest/jobs ─▶ providers/<name> ─▶ providers/http    │
                    │                        │ normalisers (pure)   │ replay store  │ provenance rows│
                    │  replay/harness   seed/*   observability/{trace,metrics,dq}                │
                    └───────────────────────────────────┬───────────────────────────────────────┘
                                                        │ pg 8 + drizzle-orm 0.45, committed SQL migrations
                                               ┌────────▼─────────┐
                                               │ Postgres 14      │ btree_gist (bitemporal exclusion), pg_trgm,
                                               │ bloomberg_dev    │ pgcrypto, uuid-ossp; declarative partitions
                                               │ bloomberg_test   │ for bars/ticks/access_log/usage_events
                                               └──────────────────┘
   packages/core  @terminal/core   pure TS, no IO, no Date.now(): types, ids, calendars, day counts,
                                   analytics engines, corporate-action adjustment, quote model + staleness,
                                   formula language, command grammar + ranking, field dictionary + formatter,
                                   function manifests + toCsv.
   packages/sdk   @terminal/sdk    zod wire schemas (REST + WS), typed RestClient + LiveClient, subscription
                                   manager, field dictionary re-export, function registry re-export.
   packages/e2e   @terminal/e2e    Playwright (channel 'chrome') against the server in PROVIDER_MODE=replay.
   fixtures/                       recorded provider responses, replay manifest, plant sessions, goldens.
```

### 1.1 Dependency direction

`core ← sdk ← { server, web }`; `e2e` has no compile-time dependency on any package (it talks HTTP/WS).

| Package | npm name | May import | Must never import |
| --- | --- | --- | --- |
| `packages/core` | `@terminal/core` | `zod` only | Node built-ins, `pg`, `fastify`, `ws`, `react`, `Date.now()` (a `Clock` is injected) |
| `packages/sdk` | `@terminal/sdk` | `@terminal/core`, `zod` | server or web internals |
| `packages/server` | `@terminal/server` | `core`, `sdk`, `fastify`, `ws`, `pg`, `drizzle-orm`, `pino`, `undici` | `react`, `web` |
| `packages/web` | `@terminal/web` | `core`, `sdk`, `react`, `react-dom`, `zustand` | `pg`, `fastify`, `server`; the globals `fetch` and `WebSocket` |
| `packages/e2e` | `@terminal/e2e` | `@playwright/test` | any package source |

Enforcement: `tsconfig.json` project `references` per package (a package can only resolve what it
references); `eslint.config.js` with `import/no-restricted-paths` for the table above and
`no-restricted-globals` (`fetch`, `WebSocket`, `XMLHttpRequest`) in `packages/web`; and
`packages/web/test/no-direct-io.test.ts`, which greps the production bundle for `new WebSocket(` and
`fetch(` outside the SDK chunk. This is how API-05 is made structural rather than aspirational: the
terminal cannot obtain a number by a path the public SDK does not also expose.

---

## 2. Monorepo directory tree

```
package.json                     npm workspaces ["packages/*"]; scripts: dev, build, test, test:live, lint,
                                 typecheck, db:migrate, db:seed, db:reset, gen:functions, gen:fields,
                                 fixtures:record, fixtures:import, replay:run, replay:diff
tsconfig.base.json               strict, ESM ("module":"NodeNext"), "target":"ES2022", paths for @terminal/*
eslint.config.js                 boundary rules (§1.1)
vitest.workspace.ts              one project per package; server project uses DATABASE_URL_TEST
scripts/
  gen-function-index.ts          writes core/src/functions/manifests/index.ts, server/src/functions/index.ts,
                                 web/src/screens/index.ts from directory listings (never hand-edited)
  gen-fields.ts                  validates core/src/fields/dictionary.ts and writes sdk/src/fields/fields.json
  fixtures-import.ts             registers fixtures/providers/raw/* into fixtures/providers/manifest.json
docs/                            REQUIREMENTS, BRIEF, ARCHITECTURE (this), DATA_MODEL, API, FUNCTIONS,
                                 PROVIDERS, TESTING, TRACEABILITY, FIXTURES
fixtures/
  providers/raw/                 verbatim captured responses (existing 50 files; see FIXTURES.md)
  providers/manifest.json        requestKey → { file, providerId, capturedAt, sha256, sourceTs }   (§8.1)
  providers/normalised/          golden NormalisedUpdate[] / row[] per raw file (diffed in tests)
  sessions/<name>/               plant replay sessions: events.ndjson, subscriptions.json, expected.ndjson (§8.2)
  golden/analytics/              QA-01 datasets: <engine>/<case>.json = { inputs, valuationTs, expected }
  seed/                          users.json, firms.json, entitlements.json, licences.json, workspaces.json
packages/
  core/                          §3.1
  sdk/                           §3.2
  server/                        §3.3
  web/                           §3.4
  e2e/                           §3.5
```

---

## 3. Package boundaries and complete module lists

### 3.1 `packages/core` (`@terminal/core`)

```
packages/core/
  package.json                       "type":"module", exports "." and "./*"
  tsconfig.json                      lib: ["ES2022"] — no "DOM", no @types/node (enforces "no IO")
  src/
    index.ts                         barrel
    clock.ts                         interface Clock { now(): number } (epoch ms); VirtualClock for tests
    types/
      instrument.ts                  AssetClass, MarketSector, IdScheme, Issuer, Issue, Instrument, Listing,
                                     MdLine, SecurityRef, ResolvedRef                                (§4.1)
      quote.ts                       Tier, SessionState, ValueState, Timestamps3, QuoteFields, QuoteState,
                                     LineState, NormalisedUpdate, ProvRef                            (§4.2)
      fields.ts                      FieldId, FieldClass, FieldDef, FieldValue
      provenance.ts                  ProvenanceRecord, LicenceEntry
      entitlement.ts                 UsageType, EntitlementRequest, FieldDecision, EntitlementDecision, ReasonCode
      function.ts                    Payload<T>, PayloadMeta, UnavailableReason
      bars.ts                        Bar, BarInterval ('1m'|'5m'|'1d'), AdjustPolicy
    ids/
      figi.ts                        FIGI format + check digit
      isin.ts                        ISIN Luhn over letter expansion
      cusip.ts                       CUSIP mod-10 double-add-double
      sedol.ts                       SEDOL weighted 1-3-1-7-3-9
      occ.ts                         OCC option symbol parse/format ('AAPL260916C00245000')
      securityRef.ts                 parse/format 'AAPL US Equity', 'SPX Index', 'EURUSD Curncy',
                                     '912797VE4 Govt', 'T 4.25 08/15/36 Govt', 'AAPL 9/16/26 C245 Equity',
                                     '/isin/US0378331005', '/figi/BBG000B9XRY4', '/cusip/…'
    calendars/
      calendar.ts                    Calendar interface, isBusinessDay, adjust(date, bdc), addBusinessDays,
                                     addTenor, combine(cals[]) = union of holidays (REF-06)
      nyse.ts                        NYSE holidays + early closes 1990–2040 (Juneteenth from 2022)
      sifma.ts                       SIFMA bond-market holidays + recommended early closes
      usgovt.ts                      US federal holidays
      target2.ts                     TARGET2 (EUR)
      fx.ts                          FX spot T+2 rules with USD holiday handling
      weekend.ts                     weekend-only calendar
      tenor.ts                       parse '1M','13W','10Y'
    daycount/
      conventions.ts                 ACT_360, ACT_365F, ACT_ACT_ISDA, ACT_ACT_ICMA(freq), THIRTY_360_US, THIRTY_E_360
      businessDay.ts                 following | modified_following | preceding | none
    analytics/
      engine.ts                      defineEngine(name, version, fn) → EngineResult { inputs, outputs, engine:{name,version},
                                     valuationTs, inputsHash }; seeded PRNG xoshiro128** (ANAL-08)
      bill.ts                        T-bill discount ↔ price ↔ investment yield (≤182d and >182d formulas)
      bond/price.ts                  street-convention price↔yield (semiannual, ACT/ACT ICMA), accrued, odd coupons
      bond/risk.ts                   Macaulay/modified duration, convexity, DV01, key-rate durations (ANAL-01)
      bond/cashflows.ts              coupon schedule generation with calendars/bdc
      curve/bootstrap.ts             bills + par coupons → discount factors; OIS from SOFR fixings + par OIS (ANAL-02)
      curve/interp.ts                linear_zero | log_linear_df | monotone_convex
      curve/curve.ts                 Curve object: df(t), zero(t), fwd(t1,t2), snapshot() with inputsHash
      swap/ois.ts                    SOFR OIS schedule (annual fixed vs daily-compounded float, ACT/360, T+2,
                                     modified following, SIFMA), PV, par rate, DV01, annuity (SWPM)
      options/bsm.ts                 BSM with continuous q, Black-76, full greeks, implied vol (Brent+Newton) (ANAL-03)
      options/tree.ts                CRR binomial, trinomial, American exercise
      options/mc.ts                  Monte Carlo antithetic + control variate, seeded
      vol/surface.ts                 chain → forward (put-call parity) → SVI slice fit → arbitrage checks (ANAL-04)
      wirp/policyPath.ts             implied overnight path between FOMC dates from bill/OIS forwards; hike/cut
                                     probabilities in 25bp steps (WIRP)
      stats/index.ts                 returns (simple/log), vol, corr, beta, OLS, drawdown, Sharpe/Sortino/IR;
                                     Conventions object exported and echoed in outputs (ANAL-07)
      portfolio/exposure.ts          sector/asset/currency exposure
      portfolio/attribution.ts       Brinson–Fachler (PORT-03)
      portfolio/risk.ts              ex-post tracking error, historical/parametric VaR, scenario shocks (PORT-04/05/06)
    adjust/
      corporateActions.ts            adjustmentFactors(actions, policy) → per-date cumulative price/volume factors;
                                     applyAdjustment(bars, factors); policies unadjusted|price|total_return (REF-09)
    quote/
      merge.ts                       composite merge rules across md lines (BUS-05)                  (§6.2)
      staleness.ts                   valueState(q, now) — the single staleness implementation (TERM-12)
      session.ts                     sessionState(calendar, now, hasPrePost) → SessionState (FEED-06)
      derive.ts                      CHG_NET_1D, CHG_PCT_1D, TICK_DIR from fields
    formula/
      lexer.ts parser.ts ast.ts evaluator.ts   computed series: refs, arithmetic, RATIO, SPREAD, NORM, MA (CHRT-07)
    command/
      tokenizer.ts grammar.ts parser.ts        [SECURITY] [SECTOR] [FUNCTION] [ARGS] with PanelContext (TERM-01/03)
      rank.ts                        ranking function over Candidate[] (TERM-02)
      index.ts                       UniverseIndex: prefix arrays, word index, trigram fallback, MRU boost
      sectors.ts                     MarketSector ↔ AssetClass map, sector aliases
    search/
      types.ts                       Candidate { kind:'instrument'|'function'|'person'|'topic', score, … }
    fields/
      dictionary.ts                  THE field dictionary: id, label, type, unit, fieldClass, sources[], updateFreq,
                                     example, version (API-07)
      format.ts                      format(fieldId, value, opts) — the only formatter (px/pct/bp/int/ccy/date)
    functions/
      manifest.ts                    FunctionManifest, ParamGrammar, LiveSpec, CsvSpec, HelpSpec, KeyBinding (§5.2)
      registry.ts                    FunctionRegistry (code/alias lookup, byTier, applicable(assetClass))
      csv.ts                         toCsv(manifest, payload, params, ctx) → CsvDocument; RFC 4180 writer
      manifests/<CODE>.ts            one file per catalogue function (BRIEF §6: 39 codes incl. aliases)
      manifests/index.ts             GENERATED barrel
  test/                              vitest unit tests; fuzz tests for ids/, command/, formula/ (QA-05)
```

### 3.2 `packages/sdk` (`@terminal/sdk`)

```
packages/sdk/
  package.json                       exports "." (browser + node), peer dep @terminal/core
  src/
    index.ts                         public surface: createClient(), LiveClient, wire schemas, fields, registry
    wire/
      envelope.ts                    ErrorEnvelope, PayloadMeta schema, AsOf schema, ProvenanceRef schema
      rest.ts                        zod request/response for every route in API.md (Rest.<Route>)
      ws.ts                          zod ClientMsg / ServerMsg discriminated unions, SubjectId regex, close codes (§6.4)
      dataRequest.ts                 the one DataRequest / DataResponse model (API-02)
      reasonCodes.ts                 ReasonCode enum (mirrors core/types/entitlement.ts)
    client/
      rest.ts                        RestClient: fetch wrapper, x-trace-id, zod validation of responses,
                                     error envelope → typed errors, ETag cache for /universe/snapshot
      ws.ts                          LiveClient: hello/welcome, sub/unsub, per-subject lastSeq, prev-chain check,
                                     resync, reconnect with backoff, notice/downgrade events (§6.5)
      subscriptions.ts               ref-counted SubscriptionManager; batches sub/unsub per animation frame;
                                     essential flag from viewport
      quoteCache.ts                  Map<subject, QuoteState> with changed-field callbacks; 1 s staleness ticker
    fields/
      fields.json                    GENERATED from core dictionary
      index.ts                       typed accessors, format() re-export
    functions/
      index.ts                       registry re-export + runFunction(code, params) typed by manifest
  test/                              contract tests: every wire schema round-trips the examples in API.md
```

### 3.3 `packages/server` (`@terminal/server`)

```
packages/server/
  package.json
  drizzle.config.ts                  out: ./drizzle/migrations, dialect postgresql
  drizzle/migrations/NNNN_<name>.sql committed SQL (DATA_MODEL.md is the authority on contents)
  src/
    index.ts                         process entry (§13 startup order)
    app.ts                           buildApp(deps): FastifyInstance — plugins, routes, ws gateway; used by tests
    config.ts                        zod env: DATABASE_URL, PORT=8080, PROVIDER_MODE=replay|record|live,
                                     REPLAY_DIR=../../fixtures/providers, SEC_USER_AGENT, OPENFIGI_API_KEY?,
                                     FRED_API_KEY?, SESSION_SECRET, CONFLATION_MS_DEFAULT=250, LOG_LEVEL
    db/
      client.ts                      pg.Pool + drizzle; withTx(fn); sets app.user_id/app.firm_id per request tx
      schema/                        Drizzle tables, one file per domain: provenance.ts, reference.ts, terms.ts,
                                     calendars.ts, timeseries.ts, corporateActions.ts, fundamentals.ts, econ.ts,
                                     curves.ts, news.ts, users.ts, entitlements.ts, workspace.ts, portfolio.ts,
                                     messaging.ts, alerts.ts, ops.ts
      bitemporal.ts                  asOf(table, {validAt, knownAt}) predicate, writeVersion(), upsertVersion() (§4.3)
      partitions.ts                  ensurePartitions(table, horizonMonths), dropExpired(table, retentionDays)
    refdata/
      resolve.ts                     SecurityResolver: SecurityRef | identifier → Instrument as-of (REF-01)
      master.ts                      issuers/issues/instruments/listings/mdLines repositories (bitemporal)
      identifiers.ts                 cross-reference writes/reads
      terms.ts                       govt_terms, option_terms, future_terms (REF-04/05)
      calendars.ts                   loads calendar tables into core Calendar objects
      classifications.ts             SIC/NAICS/GICS-like sectors (REF-07)
      indexMembership.ts             index_members with history + weights (REF-07)
      corporateActions.ts            CA repository as-of + adjust-on-read glue (REF-09)
      universe.ts                    seeded universe + Cboe symbol book + SEC tickers merge
    data/                            data services — the only readers resolvers may use
      reference.ts historical.ts intraday.ts ticks.ts snapshot.ts fundamentals.ts econ.ts curves.ts
      rates.ts options.ts news.ts filings.ts holdings.ts portfolio.ts
      request.ts                     DataRequest dispatcher (API-02) → the services above
    providers/
      types.ts                       ProviderAdapter, RawRecord, Normalised<T>, ProviderId
      http.ts                        HttpClient: live | record | replay modes, per-host token buckets,
                                     ETag/TTL cache, retries, circuit breaker (§7.2)
      replayStore.ts                 requestKey derivation, manifest read/write (§8.1)
      provenance.ts                  insertProvenance(raw) → provenanceId
      registry.ts                    adapter registry keyed by ProviderId
      licences.ts                    licence_registry + field_licence seed rows (DATA-09)
      openfigi/  cboe/  yahoo/  sec/  fred/  nyfed/  fedH15/  treasury/  bls/  worldbank/  imf/
      frankfurter/  finra/  bbgRss/  fedRss/  coingecko/  ssga/
        adapter.ts                   fetch* methods building URLs + headers
        parse.ts                     pure parsers raw → NormalisedUpdate[] | rows (fuzzed, QA-05)
    ingest/
      scheduler.ts                   in-process cron, leader lock, backoff, ingest_runs bookkeeping (§7.1)
      lock.ts                        pg_try_advisory_lock(hashtext('ingest-leader'))
      hotset.ts                      subjects to poll: subscribers ∪ connected users' watchlists ∪ always-on set
      jobs/<job>.ts                  one file per row of the table in §7.1
      jobs/index.ts                  GENERATED
    plant/
      tickerPlant.ts                 Map<subject, QuoteState>; apply(update); snapshot(subject); subscribe()
      subjects.ts                    subject grammar + parse/format (§6.1)
      composite.ts                   applies core/quote/merge.ts across md lines, dq flags (BUS-05)
      policyTier.ts                  view(state, tier): realtime→identity, delayed→identity/ring, eod→frozen (BUS-06)
      eod.ts                         end-of-day snapshot builder (official close)
      staleness.ts                   1 s sweep → status frames on state transitions (TERM-12)
      warm.ts                        warm plant from last quote_snapshots at startup
    ws/
      gateway.ts                     upgrade on /ws/v1, cookie/bearer auth, session binding, dispatch
      session.ts                     WsSession: subscriptions, field masks, conflator, backpressure state machine
      conflator.ts                   dirty-mask conflation, flush loop (§6.3)
      protocol.ts                    encode/decode via @terminal/sdk wire schemas
    entitlements/
      evaluator.ts                   evaluate(req) → EntitlementDecision (§10)
      licenceRegistry.ts             in-memory copy of licence_registry + field_licence, version-bumped on change
      accessLog.ts                   ring buffer → bulk insert every 1 s or 5 000 rows (ENTL-04)
      quotas.ts                      daily unique securities, monthly datapoints, concurrent subs (API-06)
      declarations.ts                monthly per-source usage declarations SQL (ENTL-06, DATA-02)
    functions/
      runner.ts                      runFunction(code, params, ctx): parse → resolve security → entitle →
                                     resolve → stamp meta → cache result → usage event (§5)
      context.ts                     ResolveContext construction
      resultCache.ts                 resultId → payload (LRU 500 per user, 10 min)
      export.ts                      csv(resultId | re-resolve at asOf) via core toCsv; export entitlement check
      <CODE>/resolve.ts              resolver per function; `variants` by asset class (FUNC-02)
      index.ts                       GENERATED
    http/
      trace.ts                       x-trace-id plugin (accept or mint UUID v4), child logger, response header
      errors.ts                      AppError hierarchy → ErrorEnvelope
      auth/session.ts                cookie sessions (pgcrypto-hashed tokens), single active session per user
      auth/webauthn.ts               FIDO2 registration/assertion (SEC-02)
      auth/password.ts               dev-only password login
      auth/apikeys.ts                bearer API keys bound to a user (API-01)
      routes/                        auth.ts, search.ts, universe.ts, reference.ts, data.ts, functions.ts,
                                     export.ts, fields.ts, news.ts, workspaces.ts, watchlists.ts, portfolios.ts,
                                     messages.ts, alerts.ts, help.ts, usage.ts, admin.ts, status.ts, health.ts
    search/
      snapshot.ts                    universe snapshot (instruments + functions + people + topics), ETag
      rank.ts                        server-side fallback using core/command/rank.ts (name queries ≥ 3 chars)
    news/
      ingest.ts                      RSS/Atom → news_items (NEWS-01)
      entityLink.ts                  precision-first entity resolution: exact ticker/name match only (NEWS-02)
      ranker.ts                      TOP ranking
    messaging/
      service.ts                     rooms, append-only messages with hash chain, legal hold (MSG-01/02/03)
      surveillance.ts                lexicon hits → surveillance_hits
    alerts/engine.ts                 alert evaluation on plant deltas / news / calendar → WS alerts:me (NEWS-07)
    portfolio/service.ts             CSV upload, reconciliation, analytics glue (PORT-01/02)
    observability/
      logger.ts                      pino config
      metrics.ts                     in-process counters/histograms, /metrics (Prometheus text)
      usageEvents.ts                 batched usage_events writer (FUNC-04)
      dq.ts                          data-quality monitors → dq_events (OPS-03, QA-03)
      traceQuery.ts                  GET /api/v1/admin/trace/:id join (OPS-07)
    replay/
      harness.ts                     plant session replay with VirtualClock (§8.2)
      diff.ts                        expected vs actual ndjson diff; first divergence printed
      cli.ts                         `replay:run`, `replay:diff`
    seed/
      index.ts universe.ts bars.ts rates.ts curves.ts fundamentals.ts news.ts users.ts licences.ts workspaces.ts
    test/
      db.ts app.ts clock.ts fixtures.ts   transactional DB harness against bloomberg_test, app factory, VirtualClock
  test/
    unit/  integration/  replay/  parity/    (TESTING.md)
```

### 3.4 `packages/web` (`@terminal/web`)

```
packages/web/
  index.html  vite.config.ts (proxy /api → :8080, /ws → ws://:8080)  package.json
  src/
    main.tsx  App.tsx                bootstrap: one RestClient + one LiveClient from the SDK; session gate; workspace load
    shell/
      Shell.tsx PanelGrid.tsx Panel.tsx        1/2/4 panels, per-panel frame stack, focus ring (TERM-04)
      CommandLine.tsx Autocomplete.tsx         uncontrolled input, ≤12 ranked rows (TERM-01/02)
      StatusBar.tsx                            connection, conflation ms, staleness legend, trace id, quotas
      HelpOverlay.tsx TicketDialog.tsx         HELP ×1 / ×2 (TERM-09)
    keyboard/
      keymap.ts dispatcher.ts focus.ts         GO/CANCEL/MENU/HELP/PRINT/PAGE keys, typing-anywhere routing (TERM-06/07)
    command/
      localIndex.ts                            loads /universe/snapshot into core UniverseIndex; IndexedDB cache; MRU
      dispatch.ts                              Candidate → panel action; TERM-03 context rules
    state/
      session.ts panels.ts workspace.ts subscriptions.ts settings.ts usage.ts    zustand stores
    rt/
      wsBridge.ts                              LiveClient → quoteCache → cell registry; gap/resync UI
    screen/
      ScreenRenderer.tsx                       renders ScreenSpec with the fixed widget set
      widgets/                                 Split, KeyValue, Grid, Table, Chart, Tabs, Form, Text, List, Badges, Custom
      types.ts                                 ScreenProps, ScreenSpec, Node, Cell
    grid/
      LiveGrid.tsx GridModel.ts virtualiser.ts cellRegistry.ts flash.ts sort.ts group.ts keyboard.ts (TERM-08)
    chart/
      ChartCanvas.tsx renderer.ts scales.ts layers.ts series.ts streaming.ts events.ts annotations.ts
      studies/                                 SMA, EMA, BB, RSI, MACD, VWAP, ATR, … (CHRT-04 subset)
    screens/<CODE>/Screen.tsx                  one per function; screens/index.ts GENERATED
    export/csv.ts                              PRINT → server export endpoint; never serialises locally (FUNC-03)
    format/index.ts                            thin wrappers over core format(); no arithmetic
    theme/tokens.css colours.ts type.ts        density type stack + semantic colours (TERM-11)
  test/                                        RTL + jsdom component tests; no-direct-io.test.ts; grid frame-budget test
```

### 3.5 `packages/e2e`

```
packages/e2e/
  playwright.config.ts               channel 'chrome', baseURL http://localhost:5173, webServer spawns replay-mode server
  fixtures/serverProcess.ts          starts server with PROVIDER_MODE=replay DATABASE_URL=…bloomberg_test
  tests/
    command-line.spec.ts             AAPL US Equity DES <GO>; function-only; security-only (TERM-01/03)
    autocomplete.spec.ts             per-keystroke ranking, < 80 ms budget via /api/v1/status timings (TERM-02)
    panels.spec.ts                   four panels, back-stack, workspace persistence (TERM-04/05)
    live-grid.spec.ts                QM flashes on replayed session; staleness badge after feed stops (TERM-08/12)
    export.spec.ts                   PRINT on HP yields CSV equal to screen values (FUNC-03)
    entitlement.spec.ts              export denied → reason code shown; eod-only user sees blanks (ENTL-05)
    help.spec.ts                     HELP once / twice (TERM-09)
```

---

## 4. Load-bearing models

### 4.1 Instrument hierarchy (REF-01, REF-02) — `packages/core/src/types/instrument.ts`

```ts
export type AssetClass   = 'equity'|'etf'|'index'|'fx'|'govt'|'option'|'future'|'crypto'|'rate'|'econ';
export type MarketSector = 'Equity'|'Index'|'Curncy'|'Govt'|'Corp'|'Comdty'|'Mtge'|'Muni'|'Pfd'|'M-Mkt'|'Crypto';
export type IdScheme = 'FIGI'|'COMPOSITE_FIGI'|'SHARE_CLASS_FIGI'|'ISIN'|'CUSIP'|'SEDOL'|'RIC'|'TICKER_EXCH'
                     |'LEI'|'MIC'|'CIK'|'OCC'|'PROVIDER_SYMBOL'|'SERIES_CODE';

/** Every reference row is a version. Ranges are half-open [from, to). ISO-8601 UTC strings; 'infinity' allowed. (REF-03) */
export interface Bitemporal {
  versionId: number; validFrom: string; validTo: string; txFrom: string; txTo: string; provenanceId: number;
}

/** Legal entity that issues securities: Apple Inc., US Treasury, SPDR Trust, an index provider, a central bank. */
export interface Issuer extends Bitemporal {
  issuerId: number; name: string; legalName?: string; lei?: string; cik?: string; country?: string;
  sic?: string; entityType: 'operating'|'fund'|'sovereign'|'index_provider'|'central_bank'|'other';
  fiscalYearEnd?: string;                       // 'MMDD' from SEC submissions.fiscalYearEnd
}

/** A security / share class / bond / index definition — what the issuer issued. One issuer → many issues. */
export interface Issue extends Bitemporal {
  issueId: number; issuerId: number; assetClass: AssetClass;
  securityType: string;                         // OpenFIGI securityType: 'Common Stock','ETP','REIT','Index','Spot','US GOVERNMENT','Equity Option'
  shareClassFigi?: string; isin?: string; cusip?: string; sedol?: string;
  name: string; currency: string; countryOfIssue?: string;
}

/** The thing a user names on the command line: composite level ('AAPL US'). One issue → many instruments
 *  (AAPL US, AAPL GR, …). instrumentId is the immutable internal key; never a ticker (REF-01). */
export interface Instrument extends Bitemporal {
  instrumentId: number; issueId: number; assetClass: AssetClass; marketSector: MarketSector;
  compositeFigi?: string; ticker: string; exchCode: string;      // OpenFIGI composite code 'US'; 'GOVT','FX','INDEX' for non-listed
  name: string; currency: string; primaryListingId?: number;
  status: 'active'|'delisted'|'pending'|'matured'|'expired';
  searchWeight: number;                         // autocomplete prior (index members > 1)
}

/** One instrument → many listings (venues). OpenFIGI venue FIGIs UN/UW/UA/UP… */
export interface Listing extends Bitemporal {
  listingId: number; instrumentId: number; figi?: string; mic?: string; exchCode: string; localTicker: string;
  isPrimary: boolean; listingStatus: 'active'|'suspended'|'delisted';
}

/** One listing (or the composite) → many market-data lines: a (source, providerSymbol) pair that feeds quotes. */
export interface MdLine extends Bitemporal {
  mdLineId: number; instrumentId: number; listingId?: number;     // undefined = composite line
  sourceId: string;                             // licence_registry.source_id: 'cboe.quotes','yahoo.chart','nyfed.rates',…
  providerSymbol: string;                       // cboe 'AAPL' | '_SPX'; yahoo 'AAPL' | '^GSPC' | 'EURUSD=X'; coingecko 'bitcoin'
  lineKind: 'composite'|'venue'|'derived'|'reference';
  intrinsicDelayMin: number;                    // cboe 15, yahoo 15, nyfed 0
  expectedIntervalMs: number;                   // poll cadence during session; drives staleness
  priority: number;                             // lower wins ties in composite merge
}

/** What the command parser produces before resolution. */
export interface SecurityRef {
  kind: 'ticker'|'isin'|'cusip'|'figi'|'occ'|'series';
  value: string; exchCode?: string; sector?: MarketSector;
}
export interface ResolvedRef {
  instrumentId: number; assetClass: AssetClass; marketSector: MarketSector; display: string; // 'AAPL US Equity'
  name: string; currency: string; primaryListingId?: number; mdLineIds: number[];
}
```

Hierarchy mapping from the recorded OpenFIGI fixture (`openfigi-map`): the 275 venue rows for AAPL
sharing `compositeFIGI=BBG000B9XRY4` and `shareClassFIGI=BBG001S5N8V8` become one `issue` (the share
class), one `instrument` per composite `exchCode` (`US`), one `listing` per venue FIGI (`UN`, `UW`,
`UA`, …), and one `md_line` per (source, symbol): `cboe.quotes/AAPL`, `yahoo.chart/AAPL`. Treasuries
come from the Treasury bill XML (`CUSIP_4WK=912797VE4`): issuer `US Treasury`, one issue+instrument per
CUSIP, `exchCode='GOVT'`, one `md_line` on `treasury.bills`. Rates (`SOFR`, `EFFR`) are `assetClass='rate'`
instruments under issuer `Federal Reserve Bank of New York` with `md_line` on `nyfed.rates`. Econ series
(`CPIAUCSL`, `DGS10`) are `assetClass='econ'` with `identifiers.scheme='SERIES_CODE'`.

### 4.2 Quote state (FEED-03, FEED-05, TERM-12) — `packages/core/src/types/quote.ts`

```ts
export type Tier         = 'realtime'|'delayed'|'eod';               // ordered eod < delayed < realtime
export type SessionState = 'pre'|'open'|'auction'|'halted'|'closed'|'post'|'unknown';   // FEED-06
/** Staleness verdict, orthogonal to tier: a delayed-tier value can be 'live' (updating on schedule). */
export type ValueState   = 'live'|'stale'|'closed'|'blank'|'na';
//  live   : updated within 3 × expectedIntervalMs and (during 'open') source ts still advancing
//  stale  : no capture within 3 × expectedIntervalMs, or source ts frozen > 3 × interval during 'open', or provider circuit open
//  closed : session closed/post; value is the official/last print, not expected to change
//  blank  : no value may be shown (entitlement denied / unknown); rendered as '—' + reason, never a number (ENTL-05)
//  na     : field not applicable to this instrument (bid on an index with no book)

/** FEED-05 three timestamps, epoch ms UTC. src = provider-published time (null when the provider gives none). */
export interface Timestamps3 { src: number|null; cap: number; pub: number }

export interface ProvRef { sourceId: string; provenanceId: number; srcSeq?: number }   // srcSeq = Cboe seqno

export interface QuoteFields {
  PX_LAST?: number; LAST_SIZE?: number; LAST_TRADE_TIME?: number;
  PX_BID?: number; PX_ASK?: number; BID_SIZE?: number; ASK_SIZE?: number;
  PX_OPEN?: number; PX_HIGH?: number; PX_LOW?: number; PX_CLOSE_1D?: number; PX_OFFICIAL_CLOSE?: number;
  PX_VOLUME?: number; VWAP?: number; CHG_NET_1D?: number; CHG_PCT_1D?: number; TICK_DIR?: 'up'|'down'|'flat';
  IVOL_30D?: number; SESSION_STATE?: SessionState;
  // option contracts additionally: OPT_IV, OPT_DELTA, OPT_GAMMA, OPT_VEGA, OPT_THETA, OPT_RHO, OPT_OI, OPT_THEO
  // rates additionally: RATE, RATE_P1, RATE_P25, RATE_P75, RATE_P99, RATE_VOLUME_BN, TARGET_FROM, TARGET_TO
}
export type QuoteFieldId = keyof QuoteFields;

/** Per-md-line contribution kept for BUS-05 composition and QM per-venue view. */
export interface LineState { mdLineId: number; sourceId: string; fields: QuoteFields; ts: Timestamps3; srcSeq?: number; provenanceId: number }

/** THE composite state. One per subject in the plant; the wire snapshot is a projection of it. */
export interface QuoteState {
  subject: string;                              // 'q:42'
  instrumentId: number; assetClass: AssetClass;
  seq: number;                                  // per-subject version, +1 on every applied change
  tier: Tier; delayMin: number;                 // tier and intrinsic delay of the winning line
  fields: QuoteFields;
  fieldTs: Partial<Record<QuoteFieldId, number>>;   // src ts (or cap when src absent) of last change per field
  ts: Timestamps3;                              // of the last applied update
  session: SessionState;
  state: ValueState; ageMs: number; expectedIntervalMs: number;
  prov: ProvRef;                                // of the last applied update
  lines: Record<number, LineState>;             // keyed by mdLineId
  dq: Array<'CROSS_SOURCE_DIVERGENCE'|'STALE_SOURCE'|'MISSING_CLOSE'|'PROVIDER_DOWN'>;
}

/** What every normaliser emits and the only thing plant.apply accepts. */
export interface NormalisedUpdate {
  subject: string; instrumentId: number; mdLineId: number; assetClass: AssetClass; tier: Tier;
  fields: Partial<QuoteFields>;
  ts: Timestamps3;                              // src from provider, cap = fetch completion; pub set by the plant
  prov: ProvRef;
  session?: SessionState;
}
```

Normaliser timestamp rules fixed here because two providers disagree: Cboe `last_trade_time`
(`"2026-09-15T14:26:26"`) is naive America/New_York local time and becomes `ts.src`; Cboe top-level
`timestamp` (`"2026-09-15 18:41:28"`) is UTC and becomes the provenance `source_ts`; Yahoo
`meta.regularMarketTime` and bar `timestamp[]` are epoch seconds UTC (×1000). `LAST_TRADE_TIME` is
always epoch ms.

`packages/core/src/quote/staleness.ts`:

```ts
export function valueState(q: Pick<QuoteState,'ts'|'session'|'expectedIntervalMs'|'delayMin'|'dq'>, now: number): ValueState {
  if (q.ts.cap === 0) return 'blank';
  if (q.session === 'closed' || q.session === 'post') return 'closed';
  const limit = 3 * q.expectedIntervalMs;
  if (now - q.ts.cap > limit) return 'stale';                                       // we could not poll
  if (q.dq.includes('PROVIDER_DOWN')) return 'stale';
  if (q.session === 'open' && q.ts.src !== null && now - (q.ts.src + q.delayMin * 60_000) > limit) return 'stale'; // source frozen
  return 'live';
}
```

The server computes `state` at publish time and the client recomputes it every second from the same
function, so a dead WebSocket can never leave a "live" number on screen (TERM-12).

### 4.3 Bitemporal reference tables (REF-03, STOR-03, STOR-06)

Every security-master, terms, classification, membership, licence and fundamentals table carries the
same column block and the same constraints (full DDL in DATA_MODEL.md; this block is normative):

```sql
  version_id     bigserial PRIMARY KEY,
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz NOT NULL DEFAULT 'infinity',
  tx_from        timestamptz NOT NULL DEFAULT now(),
  tx_to          timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id  bigint      NOT NULL REFERENCES provenance(provenance_id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  -- at most one CURRENT version per key and valid instant; closed versions may overlap by design
  CONSTRAINT <table>_bt_excl EXCLUDE USING gist (<key> WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&)
    WHERE (tx_to = 'infinity')

CREATE FUNCTION bt_as_of(vf timestamptz, vt timestamptz, tf timestamptz, tt timestamptz, valid_at timestamptz, known_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT vf <= valid_at AND vt > valid_at AND tf <= known_at AND tt > known_at $$;

-- Rows are immutable except for closing tx_to; DELETE is revoked from the app role.
CREATE TRIGGER <table>_bt_guard BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION bt_guard_update();
```

`packages/server/src/db/bitemporal.ts`:

```ts
export interface AsOf { validAt: Date; knownAt: Date }
export function asOf(t: BitemporalTable, at: AsOf): SQL;          // bt_as_of(t.valid_from, …, at.validAt, at.knownAt)
export function current(t: BitemporalTable): SQL;                 // valid_to = 'infinity' AND tx_to = 'infinity'
export interface VersionWrite<Row> { entityKey: Partial<Row>; validFrom: Date; validTo?: Date; data: Omit<Row, BitemporalKeys|'versionId'>; provenanceId: number; reason: 'initial'|'change'|'correction' }
/** In one transaction: close tx_to of current rows overlapping [validFrom, validTo); re-insert non-overlapping
 *  remainders as new versions; insert the new row. A CHANGE (coupon effective from D) narrows the old valid range;
 *  a CORRECTION (we were wrong all along) reuses the same valid range with a later tx_from. Never UPDATEs data. */
export function writeVersion<Row>(tx: Tx, table: BitemporalTable<Row>, w: VersionWrite<Row>): Promise<number>;
/** No-op when the current version's data is identical (ingest idempotency). */
export function upsertVersion<Row>(tx: Tx, table: BitemporalTable<Row>, w: VersionWrite<Row>): Promise<number|null>;
```

Point-in-time fundamentals (STOR-06): `xbrl_facts` rows are keyed on `(cik, concept, unit, period_start,
period_end, accession)` with `filed_at` (from SEC `filed`) and the fundamentals service signature is
`facts(cik, concepts, periods, knownAt: Date)` — `knownAt` is a required parameter, filters
`filed_at <= knownAt`, and picks the latest `filed_at` per period. There is no overload without it.

Corporate actions (REF-09, DATA-08): `corporate_actions` rows (bitemporal, `status` estimated → announced →
confirmed → paid/cancelled) are read as-of, converted to factors by `core/adjust/corporateActions.ts`,
and applied on read by `data/historical.ts` under `AdjustPolicy = 'unadjusted'|'price'|'total_return'`.
Stored bars are always unadjusted.

---

## 5. Request lifecycle: keystroke → command parse → function resolve → data → screen

Budgets (REQUIREMENTS NFR table): keystroke feedback < 16 ms; autocomplete < 80 ms p95; Tier-1 function
launch to first paint < 500 ms p95; 1-year daily history < 200 ms p95.

```
t=0     keydown 'A' in <CommandLine> of panel P                              web/shell/CommandLine.tsx
 <1 ms  uncontrolled input; panelsStore.setInput(P, text) (transient, no React tree re-render)
 <5 ms  core/command: tokenize(text) → candidate parses → rank(candidates, UniverseIndex, panelCtx)
        UniverseIndex is in memory (≈ 45k instruments from Cboe symbol book ∩ SEC tickers + 39 functions
        + people + topics), loaded from GET /api/v1/universe/snapshot (ETag, IndexedDB cache).        (TERM-02)
        Server /api/v1/search is called only for name queries ≥ 3 chars with no local hit (debounced 60 ms).
 <16 ms <Autocomplete> renders ≤ 12 memoised rows — one frame.                                        (NFR)
GO      Enter → parseCommand(text, panelCtx) → Command { security?: SecurityRef, sector?, fn?: code, args[] }
        TERM-03 rules (core/command/parser.ts):
          function-only  ('GP')            → security = panel.security  (error NO_SECURITY_LOADED if manifest.requiresSecurity)
          security-only  ('MSFT US Equity')→ fn = panel.fn ?? 'DES'
          full command                     → both replaced; args parsed by manifest.paramGrammar
        traceId = crypto.randomUUID()  (client-minted, one per user action)                          (OPS-07)
        usageStore.push({ kind:'fn.launch', code, params, panelId, traceId })                        (FUNC-04)
 <20 ms panel pushes Frame{security, fn, params, traceId} on its back-stack; Screen renders skeleton or the
        panel LRU's cached payload (stale-while-revalidate, keyed (code, instrumentId, paramsHash)).
 <25 ms sdk.ref.resolve(securityRef) — 5-min client cache; miss → GET /api/v1/ref/resolve
        sdk.fn.run(code, { instrumentId, params }, { traceId }) → POST /api/v1/functions/:code/run
server  http/trace.ts     bind x-trace-id to pino child logger; reply header x-trace-id
        auth              cookie session → { userId, firmId, sessionId }; second active session → 401 SESSION_SUPERSEDED
        functions/runner  manifest = registry.get(code); params = manifest.params.parse(body.params)   (zod)
                          instrument = SecurityResolver.resolve(instrumentId, asOf=now/now)            (REF-01)
                          reject FUNCTION_NOT_APPLICABLE unless manifest.assetClasses covers instrument.assetClass (FUNC-02)
                          decision = entitlements.evaluate({ user, firm, instrumentId, fieldIds: manifest.fieldIds(assetClass),
                                     tier:'delayed', usage:'display', purpose: code })                 (ENTL-01)
                          ctx = ResolveContext (below); resolver = module.variants[assetClass] ?? module.resolve
                          payload = await resolver(ctx, params)      → data/* services → Postgres, plant.snapshot(), providers read-through
                          meta = { traceId, asOf, tier, provenance: ctx.prov.list(), staleness: worst(cited), entitlement: decision.downgrades,
                                   unavailable: ctx.unavailable.list(), engines: ctx.engines.list() }
                          resultCache.put(resultId, { payload, meta })                                 (10 min)
                          accessLog.enqueue(decision.rows); usageEvents.enqueue({ kind:'fn.launch', …, durationMs })
                          200 { resultId, data: payload, meta }
 <150 ms client Screen(code)(props) renders payload; manifest.live(params, payload) → LiveSpec { subjects, fields }
        subscriptions.acquire(subjects, fields, essential) → one WS 'sub' → 'snap' per subject → cells populate
        first paint budget 500 ms p95 measured from GO (Playwright reads /api/v1/status timings).
HELP    HelpOverlay(manifest.help + field defs of visible fields + last traceId); second HELP within 10 s → TicketDialog
        → POST /api/v1/help/tickets (TERM-09: ticket record instead of a live analyst, BRIEF §1).
PRINT   export/csv.ts → GET /api/v1/functions/:code/csv?resultId=… → server: entitlement re-evaluated with usage:'export'
        → core toCsv(manifest, cachedPayload, params) → text/csv. Numbers are the cached payload's numbers (FUNC-03, API-05).
        If resultId expired: re-resolve at meta.asOf through the same resolver; CSV header line 'regenerated=true'.
```

### 5.1 `ResolveContext` — the only way a resolver touches data (`server/src/functions/context.ts`)

```ts
export interface ResolveContext {
  user: { userId: number; firmId: number; sessionId: string; role: 'user'|'admin' };
  traceId: string; panelId?: string;
  instrument: Instrument | null;                       // resolved as-of ctx.asOf; null when manifest.assetClasses === 'none'
  asOf: { validAt: Date; knownAt: Date };              // defaults now/now; export re-supplies the payload's values
  clock: Clock;
  db: Db;                                              // request transaction with app.user_id / app.firm_id set (RLS)
  data: DataServices;                                  // reference, historical, intraday, ticks, snapshot, fundamentals, econ, curves, rates, options, news, filings, holdings, portfolio
  plant: PlantReader;                                  // snapshot(subject), snapshotMany(subjects) — entitlement-filtered views
  providers: ReadThrough;                              // get(kind, key, { maxAgeMs }) → DB/plant if fresh, else adapter fetch + persist
  entitle: (fieldIds: FieldId[], usage: UsageType, tier?: Tier) => Promise<EntitlementDecision>;
  prov: ProvenanceCollector;                           // add(ref) → index; every value block cites one (DATA-10)
  unavailable: UnavailableCollector;                   // add({ field, reason:'NO_SOURCE'|'NOT_LICENSED'|'NOT_APPLICABLE', detail })  (EE estimates)
  engines: EngineCollector;                            // add({ name, version, inputsHash }) (ANAL-08)
  usage: UsageType;                                    // 'display' | 'export' | 'api'
  page?: { cursor: string|null; direction: 'fwd'|'back' };
}
export type FunctionResolver<P, T> = (ctx: ResolveContext, params: P) => Promise<T>;
export interface FunctionServerModule<P, T> { resolve: FunctionResolver<P, T>; variants?: Partial<Record<AssetClass, FunctionResolver<P, T>>> }
```

### 5.2 Function manifest (FUNC-01/02/03/04) — `packages/core/src/functions/manifest.ts`

```ts
export interface ParamGrammar {
  positional: Array<{ name: string; type: 'tenor'|'range'|'date'|'number'|'enum'|'string'|'security'|'topic'|'watchlist'|'index'|'currency'; values?: readonly string[]; optional?: boolean }>;
  keyed?: Record<string, { name: string; type: ParamGrammar['positional'][number]['type']; values?: readonly string[] }>;   // 'ADJ=TR'
  rest?: { name: string; type: 'text' };                       // N <free text>
}
export interface LiveSpec { subjects: string[]; fields: FieldId[] | '*'; conflationMs?: number }
export interface CsvColumn { id: string; label: string; type: 'string'|'number'|'date'|'datetime'|'boolean'; decimals?: number }
export interface CsvDocument { filename: string; attribution: string[]; asOf: string; columns: CsvColumn[]; rows: Array<Array<string|number|boolean|null>> }
export interface CsvSpec<P, T> { filename(params: P, ctx: { display: string|null; asOf: string }): string; columns: CsvColumn[] | ((params: P, payload: T) => CsvColumn[]); rows(payload: T, params: P): CsvDocument['rows'] }
export interface HelpSpec { summary: string; description: string; params: Array<{ name: string; text: string; example?: string }>; keys: Array<{ key: string; action: string }>; sources: string[]; related: string[] }
export interface KeyBinding { key: string; action: string; when?: 'grid'|'chart'|'form'|'always'; description: string }

export interface FunctionManifest<P extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>, T = unknown> {
  code: string; name: string; aliases: readonly string[];      // 'IB' → MSG, 'ICVS' → CRVF
  tier: 1|2|3;
  category: 'reference'|'pricing'|'charting'|'news'|'fundamentals'|'screening'|'rates'|'derivatives'|'portfolio'|'messaging'|'monitor'|'system';
  assetClasses: readonly AssetClass[] | 'any' | 'none';        // 'none' = takes no security (WEI, TOP, ECO, HELP)
  requiresSecurity: boolean;
  params: P;                                                   // zod object; every optional has a default
  paramGrammar: ParamGrammar;
  fieldIds: (assetClass: AssetClass | null) => FieldId[];      // entitlement pre-check set
  pageable: boolean;
  live: ((params: z.infer<P>, payload: T) => LiveSpec | null) | null;
  csv: CsvSpec<z.infer<P>, T>;
  help: HelpSpec;
  keymap: readonly KeyBinding[];
  screenKind: 'declarative'|'custom';                          // custom = owns a canvas (GP, GIP, GC, CRVF, OVML surface)
  _payload?: T;
}
export const defineFunction = <P extends z.ZodObject<z.ZodRawShape>, T>(m: FunctionManifest<P, T>) => m;
```

The registry is built from the generated barrel and re-exported by the SDK; the server module
(`server/src/functions/<CODE>/resolve.ts`) and the web screen (`web/src/screens/<CODE>/Screen.tsx`)
are looked up by `code`. `scripts/gen-function-index.ts` fails the build if a manifest lacks either.
Polymorphism (FUNC-02): `variants` keyed by asset class on the server; `payload.variant` discriminates
the client screen (`DES` on `AAPL US Equity`, `SPX Index`, `912797VE4 Govt`, `AAPL 9/16/26 C245 Equity`
and `SOFR Index` are five payload shapes behind one code).

### 5.3 Payload envelope (`core/types/function.ts`) — identical on REST, cached result and CSV

```ts
export interface PayloadMeta {
  traceId: string; resultId: string;
  asOf: { validAt: string; knownAt: string };
  tier: Tier; staleness: ValueState;
  provenance: Array<{ idx: number; sourceId: string; provenanceId: number; capturedAt: string; sourceTs: string|null; attribution: string }>;
  entitlement: Array<{ fieldId: FieldId; decision: 'downgrade'|'deny'; effectiveTier: Tier|null; reason: ReasonCode }>;
  unavailable: Array<{ field: string; reason: 'NO_SOURCE'|'NOT_LICENSED'|'NOT_APPLICABLE'; detail: string }>;
  engines: Array<{ name: string; version: string; inputsHash: string }>;
  page?: { index: number; count: number; cursor: string|null };
}
export interface Payload<T> { data: T; meta: PayloadMeta }
```

---

## 6. Real-time lifecycle: provider poll → normaliser → ticker plant → conflated WebSocket → grid cell flash

### 6.1 Subjects (BUS-02)

`packages/server/src/plant/subjects.ts`, regex in `sdk/wire/ws.ts`: `^(q|l|b1m|oc|c|r|e|n|alerts|room|sys):[A-Za-z0-9_.:-]+$`

| Subject | Meaning | Fields |
| --- | --- | --- |
| `q:<instrumentId>` | composite quote for any instrument (equity, etf, index, fx, govt, option contract, crypto, rate) | `QuoteFields` |
| `l:<mdLineId>` | single market-data line (per-source view for QM) | `QuoteFields` |
| `b1m:<instrumentId>` | forming 1-minute bar | `BAR_TS, PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME, IS_FINAL` |
| `oc:<instrumentId>` | option-chain summary for an underlying | `EXPIRIES, ATM_IV, PUT_CALL_RATIO, CONTRACT_COUNT` (contracts are `q:`) |
| `c:<curveId>` | curve as last built (`c:UST_PAR`, `c:SOFR_OIS`) | `TENORS, RATES, BUILD_ID, BUILD_TS` |
| `r:<rateCode>` | alias of `q:` for a rate instrument (`r:SOFR`) | rate fields |
| `e:<seriesCode>` | econ series latest observation / release | `VALUE, PERIOD, RELEASED_AT, PREV, REVISED` |
| `n:<scope>` | headline stream: `n:all`, `n:feed:markets`, `n:inst:<instrumentId>`, `n:topic:<code>` | `NEWS_ID, HEADLINE, PUBLISHED_AT, SOURCE_ID, LINK` |
| `alerts:me` | fired alerts for the session user | alert payload |
| `room:<roomId>` | chat room stream | message payload |
| `sys:status` | provider health, plant degraded flag, market sessions, server clock | status payload |

### 6.2 Ingest path and `plant.apply`

```
hotset.ts     polled subjects = (subjects with ≥ 1 WS subscriber) ∪ (watchlist members of connected users)
              ∪ (always-on seed: WEI indices, VIX, benchmark Treasuries, G10 FX, SOFR/EFFR); subjects with
              no subscriber decay out after 300 s. Ordered by (subscriber count desc, last poll asc).
jobs/cboeQuotes.ts   every 10 s (jitter ±1 s) over the hot set, concurrency 4, token bucket 4 req/s
  → providers/http.ts get(url)  → RawRecord { url, status, headers, body, capturedAt, sha256 }
  → replayStore.record(raw)  (PROVIDER_MODE=record)                                         (FEED-08)
  → providers/provenance.ts insert → provenanceId                                             (DATA-10)
  → providers/cboe/parse.ts normaliseQuote(raw, mdLine) → NormalisedUpdate                    (pure, fuzzed)
  → plant.apply(update)
```

`plant/tickerPlant.ts#apply(update)`:

1. `state = table.get(update.subject) ?? create(update)`; `line = state.lines[update.mdLineId]`.
2. If `update.prov.srcSeq !== undefined && line && update.prov.srcSeq <= line.srcSeq`: the poll returned
   data the plant already has → touch `line.ts.cap` and `state.ts.cap` (feeds staleness), increment
   `plant_updates_dropped_total{reason="stale_seq"}`, return. No silent gap-fill: nothing is invented (FEED-02 analogue).
3. Write the line: `state.lines[mdLineId] = { …, fields: merge(line.fields, update.fields), ts: update.ts, srcSeq, provenanceId }`.
4. Recompose (`core/quote/merge.ts`, BUS-05 rules, documented and tested):
   - `PX_LAST`, `LAST_SIZE`, `LAST_TRADE_TIME`: from the line with the greatest `ts.src` (ties: lowest `priority`).
   - `PX_BID/PX_ASK/BID_SIZE/ASK_SIZE`: only from lines with `lineKind ∈ {venue, composite}` that publish a book (Cboe); the freshest such line.
   - `PX_VOLUME = max(line volumes)` (every reachable source reports consolidated volume).
   - `PX_OPEN/HIGH/LOW`: high = max, low = min across lines with the same session date; open from the primary line.
   - `PX_CLOSE_1D`, `PX_OFFICIAL_CLOSE`: from the primary (lowest priority) line.
   - `IVOL_30D`: Cboe only. Rates/econ fields: single line.
   - `CHG_NET_1D`, `CHG_PCT_1D`, `TICK_DIR`: derived (`core/quote/derive.ts`), never taken from a provider.
   - Divergence: if two lines disagree on `PX_LAST` by > 0.5 % with `ts.src` within 60 s → `dq += 'CROSS_SOURCE_DIVERGENCE'`, `dq_events` row (OPS-03, QA-03).
5. `changed = fields whose composite value differs (NaN-safe; null is a value)`. If empty → update `ts.cap`, no seq, no fan-out.
6. Else `state.seq += 1`; `fieldTs[f] = update.ts.src ?? update.ts.cap`; `state.ts = { src, cap, pub: clock.now() }`;
   `state.prov = update.prov`; `state.session = sessionState(calendar, now)`; `state.state = valueState(state, now)`.
7. For every `WsSession` subscribed to the subject: `session.conflator.mark(subject, changedMask)`.
8. `plant_publish_latency_ms.observe(pub − cap)`; budget < 1 ms p99 in-process.

Field masks are `Uint32Array` bitsets over the dictionary's field index, so a session subscribed to
`PX_LAST` never receives `PX_BID` (BUS-02) and fan-out costs O(subscribers) bit-ors. `Composite` state
is the truth; there is no delta log — recovery is always a fresh snapshot (BUS-07).

### 6.3 Per-session conflation and backpressure (BUS-03, BUS-04, NFR-02)

`packages/server/src/ws/conflator.ts`:

```ts
interface Subscription { subject: string; fieldMask: Uint32Array; lastSentSeq: number; tier: Tier; essential: boolean; denied: Map<FieldId, ReasonCode> }
export class Conflator {
  requestedMs: number;          // hello.conflationMs: default 250, min 50, max 5000
  effectiveMs: number;          // widened by backpressure; never below requestedMs; eod-tier subjects flush at most every 60 000 ms
  private dirty = new Map<string, Uint32Array>();       // subject → changed-field mask since last flush (insertion order)
  mark(subject: string, mask: Uint32Array): void        // OR into dirty; arm timer if idle
  flush(): void {
    if (ws.bufferedAmount > HARD_BYTES) return;         // keep dirty; try next tick — nothing is lost
    const frames: ServerMsg[] = [];
    for (const [subject, mask] of this.dirty) {
      const state = plant.get(subject); const sub = subs.get(subject);
      const view  = policyTier.view(state, sub.tier);   // BUS-06
      const f     = pick(view.fields, mask & sub.fieldMask);   // latest values only, read at flush time
      frames.push({ t:'delta', s: subject, seq: view.seq, prev: sub.lastSentSeq, f, fts: pick(view.fieldTs, mask), ts: view.ts, st: view.state });
      sub.lastSentSeq = view.seq;
    }
    this.dirty.clear(); ws.send(encode({ t:'batch', m: frames }));
  }
}
```

Guarantees: the latest value is never dropped (values are read from the composite at flush time; a
subject stays dirty until flushed; a skipped flush keeps the dirty set); at most one `batch` per
session per `effectiveMs`; a subject appears at most once per batch; `seq` values may skip (that is
conflation) but the `prev` chain never does.

Backpressure thresholds per session: `SOFT_BYTES = 256 KiB`, `HARD_BYTES = 2 MiB`, `GRACE_MS = 10 000`, `MAX_MS = 5 000`.

| Condition (checked at every flush) | Action | Wire |
| --- | --- | --- |
| `bufferedAmount > SOFT` | `effectiveMs = min(effectiveMs × 2, MAX_MS)` | `notice { kind:'slow-consumer', action:'conflation-widened', conflationMs }` |
| `bufferedAmount < SOFT/4` for 3 flushes | `effectiveMs = max(effectiveMs / 2, requestedMs)` | `notice { action:'conflation-restored' }` |
| `bufferedAmount > HARD` | skip flush, dirty retained | — |
| `> HARD` continuously for `GRACE_MS` | shed subscriptions with `essential:false` (off-viewport rows, `n:*`, `oc:*`, `b1m:*`) | `status { s, st:'shed' }` per subject + `notice { action:'shed' }` |
| still `> HARD` after another `GRACE_MS` | close | `4008 SLOW_CONSUMER` |
| plant overload: event-loop lag > 200 ms or apply queue > 50 000 | global floor `effectiveMs ≥ 1000` for every session; shed non-essential first; `PX_LAST`/`CHG_*` never shed | `sys:status` delta `{ plant:'degraded' }` |

Nothing is dropped silently: every widen/shed/close is a wire message, a metric and a `dq_events` row.

### 6.4 Wire protocol (BUS-01..08, ENTL-05) — `packages/sdk/src/wire/ws.ts`

Endpoint `/ws/v1`; text frames, JSON; one message per frame except `batch`. Timestamps are epoch ms.

```ts
export const ClientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.literal(1), client: z.string(), token: z.string().optional(),
             conflationMs: z.number().int().min(50).max(5000).default(250), resume: z.boolean().default(false), traceId: z.string().optional() }),
  z.object({ t: z.literal('sub'), id: z.number().int(),
             subjects: z.array(z.object({ s: SubjectId, f: z.array(FieldId).max(100), essential: z.boolean().default(true), known: z.number().int().optional() })).max(10000),
             tier: Tier.optional() }),
  z.object({ t: z.literal('unsub'), subjects: z.array(SubjectId) }),
  z.object({ t: z.literal('resync'), subjects: z.array(SubjectId) }),
  z.object({ t: z.literal('conflation'), ms: z.number().int().min(50).max(5000) }),
  z.object({ t: z.literal('essential'), subjects: z.array(SubjectId), essential: z.boolean() }),   // viewport changes
  z.object({ t: z.literal('ping'), n: z.number().int() }),
]);

const Ts = z.object({ src: z.number().nullable(), cap: z.number(), pub: z.number() });             // FEED-05
const Prov = z.object({ p: z.string(), id: z.number(), seq: z.number().optional() });
export const Snap  = z.object({ t: z.literal('snap'), s: SubjectId, seq: z.number().int(), tier: Tier, reason: ReasonCode,
                       f: z.record(FieldId, FieldValue), fts: z.record(FieldId, z.number()).optional(),
                       r: z.record(FieldId, ReasonCode).optional(),       // per-field denials → field is null and blank (ENTL-05)
                       ts: Ts, st: ValueState, session: SessionState, prov: Prov, ac: AssetClass, id: z.number().nullable() });
export const Delta = z.object({ t: z.literal('delta'), s: SubjectId, seq: z.number().int(), prev: z.number().int(),
                       f: z.record(FieldId, FieldValue), fts: z.record(FieldId, z.number()).optional(), ts: Ts, st: ValueState, prov: Prov.optional() });
export const Status = z.object({ t: z.literal('status'), s: SubjectId, st: z.enum(['pending','stale','halted','closed','blank','shed','gone']), reason: z.string().optional(), ts: z.number() });
export const ServerMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), sessionId: z.string(), serverTime: z.number(), protocol: z.literal(1), conflationMs: z.number(),
             heartbeatMs: z.number(), limits: z.object({ maxSubscriptions: z.number(), maxFields: z.number() }) }),
  z.object({ t: z.literal('subAck'), id: z.number().int(), accepted: z.array(z.object({ s: SubjectId, tier: Tier, reason: ReasonCode })),
             rejected: z.array(z.object({ s: SubjectId, code: z.enum(['SUBJECT_UNKNOWN','NOT_ENTITLED','QUOTA_EXCEEDED','FIELD_UNKNOWN','LIMIT']), reason: z.string() })), traceId: z.string() }),
  Snap, Delta, Status,
  z.object({ t: z.literal('batch'), m: z.array(z.union([Snap, Delta, Status])) }),
  z.object({ t: z.literal('downgrade'), s: SubjectId.optional(), from: Tier, to: Tier.nullable(), reason: ReasonCode }),
  z.object({ t: z.literal('resync'), subjects: z.array(SubjectId).optional() }),                 // server asks client to re-sub (plant restart)
  z.object({ t: z.literal('notice'), kind: z.enum(['slow-consumer','overload','maintenance']),
             action: z.enum(['conflation-widened','conflation-restored','shed','disconnect-soon']), conflationMs: z.number().optional(), detail: z.string().optional() }),
  z.object({ t: z.literal('alert'), alertId: z.string(), firedAt: z.number(), payload: z.unknown() }),
  z.object({ t: z.literal('msg'), room: z.string(), message: z.unknown() }),
  z.object({ t: z.literal('err'), code: z.string(), message: z.string(), traceId: z.string(), fatal: z.boolean() }),
  z.object({ t: z.literal('pong'), n: z.number().int(), serverTime: z.number() }),
  z.object({ t: z.literal('bye'), code: z.number().int(), reason: z.string() }),
]);
```

Normative rules:

1. After `sub`: `subAck`, then exactly one `snap` per accepted subject (inside `batch`), then `delta`s. A
   `snap` carries the full subscribed field set for the granted tier; unavailable fields are `null` with
   a reason in `r` (never a stale number, ENTL-05).
2. `seq` is the per-subject composite version. `delta.prev` is the `seq` this session last received for
   the subject. Client rule: apply iff `prev === lastSeq[s]`; drop iff `seq <= lastSeq[s]`; otherwise send
   `resync { subjects:[s] }` and ignore deltas for `s` until the next `snap`.
3. Reconnect (BUS-07): backoff 250 ms → 8 s with jitter; `hello { resume:true }` → `welcome`; client
   re-sends `sub` for every live subscription with `known: lastSeq`. The server always answers with fresh
   `snap`s — deltas are never replayed — so application is idempotent, gap-free and duplicate-free.
   `known` is only used for the `ws_resync_gap` metric.
4. `st` in every frame is the server's verdict at `pub`; the client recomputes with `core/quote/staleness.ts`
   every second (TERM-12).
5. Entitlement on `sub` runs the same evaluator as REST with `usage:'display'`, `purpose:'ws.sub'`; every
   decision is access-logged. Downgrades are sent once as `downgrade` and repeated in every `snap.reason`.
6. Limits (BUS-08 scaled to v1): 10 000 subjects per session, 100 fields per subject, `sub` ≤ 1 MiB, batch
   frame ≤ 1 MiB (split when larger). Heartbeat: client `ping` every 15 s; server closes after 45 s silence.
7. Close codes: `1000` normal · `1001` server shutdown (reconnect) · `4000 IDLE` · `4001 AUTH_REQUIRED` ·
   `4002 PROTOCOL_ERROR` · `4003 SESSION_SUPERSEDED` · `4008 SLOW_CONSUMER` · `4010 PROTOCOL_VERSION` ·
   `4011 SUBSCRIPTION_LIMIT` · `4029 RATE_LIMITED`.

Example exchange:

```
→ {"t":"hello","protocol":1,"client":"web/0.1.0","conflationMs":250}
← {"t":"welcome","sessionId":"7f3c…","serverTime":1789497943123,"protocol":1,"conflationMs":250,"heartbeatMs":15000,"limits":{"maxSubscriptions":10000,"maxFields":100}}
→ {"t":"sub","id":1,"subjects":[{"s":"q:42","f":["PX_LAST","PX_BID","PX_ASK","PX_VOLUME","CHG_PCT_1D"]}]}
← {"t":"subAck","id":1,"accepted":[{"s":"q:42","tier":"delayed","reason":"SOURCE_TIER_CAP"}],"rejected":[],"traceId":"…"}
← {"t":"batch","m":[{"t":"snap","s":"q:42","seq":4182,"tier":"delayed","reason":"SOURCE_TIER_CAP",
     "f":{"PX_LAST":330.27,"PX_BID":330.25,"PX_ASK":330.28,"PX_VOLUME":16591786,"CHG_PCT_1D":-0.8436},
     "ts":{"src":1789489586000,"cap":1789497688412,"pub":1789497688413},"st":"live","session":"open",
     "prov":{"p":"cboe.quotes","id":88213,"seq":15972883317},"ac":"equity","id":42}]}
← {"t":"batch","m":[{"t":"delta","s":"q:42","seq":4185,"prev":4182,"f":{"PX_LAST":330.31,"PX_VOLUME":16601102},
     "ts":{"src":1789489601000,"cap":1789497703400,"pub":1789497703401},"st":"live"}]}
```

### 6.5 Tier policy (BUS-06, ENTL-05) — `plant/policyTier.ts`

| Granted tier | View |
| --- | --- |
| `realtime` | No v1 source can supply it; requests are downgraded to `delayed` with `SOURCE_TIER_CAP`. The identity view exists so a future realtime line needs no protocol change. |
| `delayed` | Identity on Cboe/Yahoo lines (already ≥ 15 min delayed at source; the delay is not doubled). For a realtime line, a per-subject 15-minute ring buffer (`plant/delay.ts`, shape only, out of v1 scope). |
| `eod` | `plant/eod.ts` snapshot: `PX_OFFICIAL_CLOSE, PX_CLOSE_1D, PX_VOLUME, PX_OPEN/HIGH/LOW` of the last completed session; `ts.src` = session close; other fields `null` with `r: 'TIER_EOD'`; flushed at most every 60 s. |

### 6.6 Client side: WS → quote cache → grid cell flash (TERM-08, TERM-12)

```
sdk/client/ws.ts        decode → prev-chain check → quoteCache.apply(subject, delta) → listeners(subject, changedFields)
web/rt/wsBridge.ts      forwards (subject, changedFields) to grid/cellRegistry; handles status 'shed' (re-sub when row scrolls into view)
web/grid/cellRegistry   Map<subject, Map<fieldId, HTMLElement>>; on change: cell.textContent = format(fieldId, value);
                        cell.dataset.state = st; toggles .flash-up/.flash-down (removed on animationend, 700 ms)
                        all mutations coalesced into one requestAnimationFrame per frame; React is not on this path
web/grid/virtualiser    renders only visible rows (+ 10 overscan); scrolling marks rows essential/non-essential → 'essential' msg
web/grid/LiveGrid.tsx   React owns columns, sort, group, selection, keyboard (arrow/home/end/enter/space); cells are refs
staleness ticker        1 s: cellRegistry.sweep(now) recomputes valueState per subject and restyles (colour + '·' glyph) (TERM-12)
```

Frame budget test (`web/test/grid.frame-budget.test.ts`): 2 000 visible cells receiving 5 000 field
changes per second must keep rAF callbacks under 8 ms p95 in jsdom-instrumented timing and under 16 ms
in the Playwright perf spec.

---

## 7. Ingest and scheduler

### 7.1 Scheduler (`server/src/ingest/scheduler.ts`)

```ts
export interface IngestJob {
  id: string;                                                  // 'cboe.quotes.poll'
  schedule: string | { everyMs: number; jitterMs?: number; marketHoursOnly?: boolean; offHoursEveryMs?: number };  // cron (America/New_York) or interval
  provider: ProviderId;                                        // for circuit breaker + rate budget
  priority: 1|2|3;                                             // 1 = hot-set real-time, 2 = daily, 3 = weekly/reference
  timeoutMs: number;
  run(ctx: JobContext): Promise<JobResult>;                    // JobResult { fetched, inserted, updated, skipped, errors: JobError[], provenanceIds: number[] }
}
export interface JobContext { clock: Clock; db: Db; providers: ProviderRegistry; plant: TickerPlant; hotset: HotSet; traceId: string; log: Logger }
```

Rules: one running instance per job; the scheduler tick is every second with an injected `Clock` (tests
drive it with `VirtualClock`); leader election via `pg_try_advisory_lock(hashtext('ingest-leader'))` so a
second process never double-runs; each run writes `ingest_runs (job_id, started_at, finished_at, status,
fetched, inserted, errors, trace_id)`; failures back off `2^n × 5 s` capped at 10 min; per-provider
circuit breaker opens after 5 consecutive failures and half-opens after 60 s; while open, the affected
md lines carry `dq 'PROVIDER_DOWN'` and their subjects render `stale` (TERM-12 is a plant concern);
provider token buckets are shared between scheduler and on-demand read-through calls, and the scheduler
may use at most 70 % of a bucket so interactive requests are never starved. Every job is idempotent:
time-series upserts on natural keys, bitemporal tables via `upsertVersion`.

| Job file (`ingest/jobs/`) | Cadence | Provider (`licence_registry.source_id`) | Writes |
| --- | --- | --- | --- |
| `symbologyRefresh.ts` | daily 06:00 ET + on demand | `openfigi.mapping`, `sec.tickers` | issuers, issues, instruments, listings, identifiers (bitemporal) |
| `universeSymbolBook.ts` | daily 06:30 ET | `cboe.symbolBook` | search snapshot candidates (not master rows) |
| `cboeQuotes.ts` | 10 s hot set 04:00–20:00 ET; 5 min off-hours | `cboe.quotes` | plant `q:`, `quote_ticks`, `quote_snapshots` |
| `cboeOptions.ts` | 60 s for underlyings with `oc:` or option `q:` subscribers; daily otherwise | `cboe.options` | option_terms (new contracts), plant `q:` per contract, `oc:` summary |
| `yahooIntraday.ts` | 60 s for `b1m:` subscribers; 5 min hot set | `yahoo.chart` | bars_intraday (1m), plant `b1m:` and `q:` line |
| `yahooDaily.ts` | 17:30 ET daily + backfill at seed | `yahoo.chart` | bars_daily (unadjusted), corporate_actions (dividends, splits from `events`) |
| `fxIntraday.ts` | 60 s | `yahoo.chart` (`EURUSD=X` …) | plant `q:` for fx |
| `fxEod.ts` | 16:15 CET daily | `frankfurter` | bars_daily for fx (ECB reference) |
| `secSubmissions.ts` | hourly per universe CIK; 8-K atom every 60 s | `sec.submissions`, `sec.atom` | filings, news_items (kind 'filing') |
| `secCompanyFacts.ts` | daily per CIK, staggered ≤ 10 req/s | `sec.companyfacts` | xbrl_facts (PIT keyed on `filed`), fin_statements |
| `secFrames.ts` | weekly | `sec.frames` | xbrl_frames (EQS universe screens) |
| `secNport.ts` | monthly + on new NPORT-P filing | `sec.submissions`, `sec.archives` | index_members (SPY → S&P 500 weights) |
| `ssgaHoldings.ts` | daily 19:00 ET | `ssga.holdings` | index_members (daily weights) |
| `treasuryCurves.ts` | 18:00 ET daily (≈ 18 s fetch) | `treasury.yieldcurve`, `treasury.bills` | curve_points (par), govt_terms (on-the-run bills by CUSIP), plant `c:UST_PAR` |
| `fedRates.ts` | 08:30 ET daily | `nyfed.rates`, `fed.h15` | econ_observations (SOFR/EFFR/OBFR/TGCR/BGCR + percentiles, H.15 CMT), plant `r:` |
| `fredSeries.ts` | daily per series, 1 req/s | `fred.csv` | econ_observations with vintage detection (new value for an old date → new vintage) |
| `blsSeries.ts` | daily (≤ 25 queries/day: 5 series) | `bls.timeseries` | econ_observations |
| `worldMacro.ts` | weekly | `worldbank`, `imf.datamapper` | econ_observations (annual) |
| `econCalendar.ts` | daily 05:00 ET | `fred.calendar`, `bls.schedule`, `fed.fomc` | econ_release_events |
| `newsRss.ts` | 60 s per feed | `bbg.rss`, `fed.rss` | news_items, news_entity_links; plant `n:` |
| `shortInterest.ts` | twice monthly | `finra.shortInterest` | short_interest |
| `crypto.ts` | 60 s | `coingecko.simple` | plant `q:` for crypto |
| `partitionMaintenance.ts` | daily 01:00 ET | — | create next month's partitions; drop partitions older than `retention_days` (STOR-07) |
| `retentionPurge.ts` | daily 01:30 ET | — | delete rows beyond `licence_registry.retention_days` in non-partitioned tables (STOR-07) |
| `dqMonitors.ts` | 60 s | — | dq_events: stale ticks, divergence, missing close, field population, poll anomalies (OPS-03) |
| `reconcile.ts` | 18:45 ET daily | — | Cboe close vs Yahoo close per hot instrument; divergence > 0.5 % → dq_events (QA-03) |
| `usageDeclarations.ts` | monthly, 1st 02:00 ET | — | usage_declarations from access_log (ENTL-06, DATA-02) |

### 7.2 Provider HTTP client (`server/src/providers/http.ts`)

`HttpClient.get(req: { providerId, url, headers?, body?, cacheTtlMs? }) → RawRecord`. Modes:
`live` (undici, per-host token bucket, ETag/TTL cache, 3 retries with jitter, circuit breaker), `record`
(live + write-through to the replay store), `replay` (serve only from the store; miss → `ReplayMissError`).
Mandatory headers: SEC `User-Agent: <SEC_USER_AGENT>` (descriptive, with contact email); Yahoo a
browser-like `User-Agent` (empty body otherwise); OpenFIGI `X-OPENFIGI-APIKEY` when configured. Token
buckets: openfigi 25/min, sec 10/s, cboe 4/s, yahoo 2/s, fred 1/s, bls 25/day, treasury 1/min, others 1/s.

Read-through cache (`ctx.providers.get(kind, key, { maxAgeMs })`): resolvers never call adapters
directly; the read-through returns DB/plant data if fresh enough, otherwise fetches through the same
adapter and buckets and persists. Slow sources (Treasury XML ≈ 18 s) are only ever fetched by the
scheduler; resolvers read `curve_points`.

---

## 8. Replay harness (FEED-08, QA-02)

### 8.1 Provider replay store (`server/src/providers/replayStore.ts`)

- Request key: `sha256(providerId + '|' + METHOD + '|' + url-with-sorted-query + '|' + sha256(body))`, hex.
- `fixtures/providers/manifest.json`: `{ "<requestKey>": { "file": "raw/cboe-quote-AAPL.json", "providerId": "cboe.quotes", "url": "…", "capturedAt": "2026-09-15T18:41:28Z", "sha256": "…", "sourceTs": "2026-09-15T18:41:28Z" } }`.
  `scripts/fixtures-import.ts` registers the existing 50 raw files (FIXTURES.md) by reconstructing their
  request URLs; `npm run fixtures:record` (PROVIDER_MODE=record) appends new entries as
  `raw/<providerId>/<requestKey>.<ext>`.
- `PROVIDER_MODE=replay` is the default for `npm test`, e2e and the offline demo; a miss throws
  `ReplayMissError` so tests fail loudly and never touch the network.
- `fixtures/providers/normalised/<file>.json` holds the golden normaliser output for each raw file;
  `server/test/replay/normalisers.test.ts` diffs every adapter's `parse()` against it.

### 8.2 Plant session replay (`server/src/replay/harness.ts`)

A session directory `fixtures/sessions/<name>/` contains `events.ndjson` (one line per captured
exchange: `{ tOffsetMs, providerId, requestKey }`), `subscriptions.json` (subjects, fields, tiers and
`conflationMs` of the reference subscribers) and `expected.ndjson` (the state log of the last accepted
run). `replay:run --session <name> --speed max` builds a plant with a `VirtualClock`, drives the real
adapters and normalisers through the replay store at the recorded offsets, runs the real conflators for
the reference subscribers, and writes a state log: every applied composite change
`(subject, seq, changedFields, ts.src)` and every outbound WS frame per reference subscriber, plus the
function-output matrix (every manifest × seed securities) at the session end. `replay:diff` compares two
state logs ignoring `ts.cap`/`ts.pub` and exits non-zero on the first divergence; `npm test` runs every
committed session against `expected.ndjson`. Because normalisers are pure and the clock is virtual, two
runs on the same store are bit-identical (FEED-08), and a release candidate is compared against the
previous release on the same sessions (QA-02).

---

## 9. Provenance and licence registry (DATA-09, DATA-10, STOR-07)

```sql
CREATE TABLE licence_registry (                 -- DATA-09: machine-readable terms per source; bitemporal
  version_id      bigserial PRIMARY KEY,
  source_id       text NOT NULL,                -- 'cboe.quotes','cboe.options','cboe.symbolBook','yahoo.chart','yahoo.search','openfigi.mapping',
                                                -- 'sec.tickers','sec.submissions','sec.companyfacts','sec.frames','sec.atom','sec.archives','fred.csv',
                                                -- 'fred.calendar','nyfed.rates','fed.h15','fed.rss','fed.fomc','treasury.yieldcurve','treasury.bills',
                                                -- 'bls.timeseries','bls.schedule','worldbank','imf.datamapper','frankfurter','finra.shortInterest',
                                                -- 'bbg.rss','coingecko.simple','ssga.holdings'
  source_name     text NOT NULL, terms_url text, contract_ref text,
  display         boolean NOT NULL DEFAULT true,
  non_display     boolean NOT NULL DEFAULT false,   -- DATA-01 distinction: programmatic use
  derived         boolean NOT NULL DEFAULT true,
  redistribution  boolean NOT NULL DEFAULT false,
  export_allowed  boolean NOT NULL DEFAULT true,
  api_allowed     boolean NOT NULL DEFAULT true,
  max_tier        tier NOT NULL DEFAULT 'delayed',
  intrinsic_delay_min int NOT NULL DEFAULT 15,
  retention_days  int,                              -- NULL = unlimited; drives partition drops (STOR-07)
  attribution     text NOT NULL,                    -- shown in screen footers and CSV header
  rate_limit      text NOT NULL,                    -- '25/min', '10/s' — documentation; buckets are configured in providers/http.ts
  notes           text,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint,                              -- NULL only for the seed row (bootstrap)
  CONSTRAINT licence_registry_bt_excl EXCLUDE USING gist (source_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);

CREATE TABLE field_licence (                    -- every field × asset class → the source that supplies it
  field_id     text NOT NULL,                   -- from core/fields/dictionary.ts
  asset_class  asset_class NOT NULL,
  source_id    text NOT NULL,
  field_class  field_class NOT NULL,            -- 'price','reference','fundamental','econ','news','analytic','derived','portfolio'
  PRIMARY KEY (field_id, asset_class)
);

CREATE TABLE provenance (                       -- DATA-10: one row per raw provider exchange
  provenance_id   bigserial PRIMARY KEY,
  source_id       text NOT NULL,
  request_key     text NOT NULL,                -- = replay store key
  request_url     text NOT NULL,
  request_hash    bytea NOT NULL,
  response_sha256 bytea NOT NULL,
  http_status     int NOT NULL, bytes int NOT NULL,
  captured_at     timestamptz NOT NULL,         -- FEED-05 'cap'
  source_ts       timestamptz,                  -- provider-published time when present ('src')
  adapter_version text NOT NULL,
  trace_id        uuid                          -- when fetched on behalf of a request
);
CREATE INDEX provenance_source_captured_idx ON provenance (source_id, captured_at DESC);
CREATE INDEX provenance_request_key_idx ON provenance (request_key);
```

Every value-bearing row (bars, ticks, facts, econ observations, curve points, news items, reference
versions) carries `provenance_id`; in-memory `QuoteState` carries `prov` per line and for the composite;
function payloads carry `meta.provenance[]` and each screen block cites an index into it; `Ctrl+I` on any
cell opens the provenance panel (source, captured-at, source-ts, licence terms, request key → raw
fixture). `GET /api/v1/fields/:id` shows the governing licence for a field (API-07). The registry is
seeded from `providers/licences.ts`, is the only input to the evaluator's source dimension, and its
`retention_days` is the only input to partition dropping and `retentionPurge`. All v1 sources are public
and keyless; the seed records them as `display=true, redistribution=false, max_tier='delayed'` (Cboe,
Yahoo) or `'eod'` (daily sources), which is what DATA-01 would populate with real contracts.

---

## 10. Entitlement evaluation (ENTL-01..06, API-06, SEC-03)

```ts
// packages/core/src/types/entitlement.ts
export type UsageType = 'display'|'export'|'api';
export type ReasonCode = 'OK'|'SOURCE_TIER_CAP'|'NOT_ENTITLED_TIER'|'NO_FIRM_ENTITLEMENT'|'NO_USER_ENTITLEMENT'
  |'LICENCE_FORBIDS_USAGE'|'TIER_EOD'|'CONCURRENT_SESSION'|'QUOTA_EXCEEDED'|'PROVIDER_DOWN'|'SUBJECT_UNKNOWN'|'FIELD_UNKNOWN'|'NOT_IN_UNIVERSE';
export interface EntitlementRequest { userId: number; firmId: number; sessionId: string; instrumentId: number|null; assetClass: AssetClass|null;
  fieldIds: FieldId[]; tier: Tier; usage: UsageType; purpose: string /* function code | route | 'ws.sub' */; traceId: string }
export interface FieldDecision { fieldId: FieldId; sourceId: string; fieldClass: FieldClass; decision: 'allow'|'downgrade'|'deny'; effectiveTier: Tier|null; reason: ReasonCode }
export interface EntitlementDecision { effectiveTier: Tier|null; fields: FieldDecision[]; downgrades: Array<{ fieldId: FieldId; reason: ReasonCode }>; logIds: number[] }
```

`server/src/entitlements/evaluator.ts#evaluate(req)` runs server-side before any data service read and
on every WS `sub` (ENTL-01); there is no data-service entry point without a decision (enforced by
`server/test/unit/entitlement.guard.test.ts`, which instantiates every service with a throwing stub and
asserts every public method throws). Order, first failing rule decides per field:

1. Field → source: `field_licence[(fieldId, assetClass)]` → `sourceId`, `fieldClass`. Unknown → `FIELD_UNKNOWN` (deny).
2. Licence gate: `licence_registry[sourceId]` must allow the usage (`display`, `export_allowed`, `api_allowed`); otherwise `LICENCE_FORBIDS_USAGE` (deny). Export never silently exports a subset: any denied field fails the whole CSV with the reason.
3. Source ceiling: `cap = licence.max_tier` (a 15-min delayed source can never serve `realtime`; a daily source can never serve `delayed`).
4. Firm contract: `entitlement_grants` rows with `subject_kind='firm'`, valid as-of now, for `(sourceId, fieldClass)`; none → `NO_FIRM_ENTITLEMENT` (deny → blank).
5. User subscription: `subject_kind='user'` rows; effective tier = `min(cap, firm tier, user tier)` (intersection, ENTL-02); no user row → `NO_USER_ENTITLEMENT`. The seed grants every user `delayed` on every public source (BRIEF §5.6).
6. Requested tier above effective → `downgrade` with `NOT_ENTITLED_TIER` (grant cap) or `SOURCE_TIER_CAP` (licence cap). A downgrade always yields the lower tier's fresh value or a blank, never a stale higher-tier value (ENTL-05).
7. Natural-person binding (ENTL-03, SEC-03): grants are on `user_id`, never on a seat or device; `sessions` allows one active session per user — a new login supersedes the old one, whose WS receives `bye 4003 SESSION_SUPERSEDED`; the event is written to `access_log` with `decision='deny', reason='CONCURRENT_SESSION'` and counted in `sessions.superseded_count`.
8. Quotas (API-06): for `usage:'api'` (bearer sessions) `quotas.ts` checks daily unique instruments (default 500), monthly datapoints (2 000 000) and concurrent subscriptions (2 000 per API session; 10 000 per web session) → `QUOTA_EXCEEDED` (HTTP 429 / `subAck.rejected`).
9. Log (ENTL-04): one `access_log` row per `(user, instrument, field, decision)` with `usage`, `purpose`, `tier`, `ts`, `trace_id`, appended to an in-memory ring and bulk-inserted every 1 s or 5 000 rows; never on the response path. `access_log` is range-partitioned by month and retained for `max(licence.retention_days, 7 years)`.
10. Cache: decision inputs per `(userId, sourceId, fieldClass, usage)` for 60 s, invalidated by a version bump on any grant or licence change; the instrument → md line → source map is cached with the plant.
11. Declarations (ENTL-06, DATA-02): `GET /api/v1/admin/declarations?month=YYYY-MM` runs `declarations.ts` — distinct users per `source_id × field_class × tier × usage` from `access_log`, reconciled against `firms.seat_count`, stored in `usage_declarations`.

The client never filters: the server nulls denied fields and returns the reason (`snap.r`,
`meta.entitlement`), and the screen only renders the badge.

---

## 11. Observability (OPS-07, OPS-03, OPS-04, FUNC-04)

- **Trace ids.** UUID v4 minted by the SDK per user action (`crypto.randomUUID()`, available in browsers
  and Node 22) or by `http/trace.ts` for requests without one; carried as `x-trace-id` request and
  response header, WS `hello.traceId`/`subAck.traceId`/`err.traceId`, the pino child logger, `usage_events.trace_id`,
  `access_log.trace_id`, `ingest_runs.trace_id`, `provenance.trace_id` (fetches triggered on behalf of a
  request), and `payload.meta.traceId`. The HELP overlay and every error dialog show the last trace id.
  `GET /api/v1/admin/trace/:id` (`observability/traceQuery.ts`) joins logs, access log, usage events,
  provenance rows and the request keys they point at, so "why is this number wrong?" is one query from
  one string to the raw recorded response (OPS-07).
- **Logs.** pino JSON to stdout; per-module levels; request log with route, status, latency bucket, userId, traceId.
- **Metrics** (`GET /metrics`, Prometheus text): `plant_updates_applied_total`, `plant_updates_dropped_total{reason}`,
  `plant_publish_latency_ms` (histogram), `ws_sessions`, `ws_subscriptions`, `ws_buffered_bytes` (per-session bucket gauge),
  `conflation_effective_ms` (histogram), `ws_resync_gap`, `provider_requests_total{source,status}`, `provider_latency_ms{source}`,
  `provider_circuit_state{source}`, `ingest_run_duration_ms{job}`, `scheduler_lag_ms`, `fn_resolve_ms{code}`, `db_query_ms{name}`,
  `db_pool_in_use`, `search_local_hit_ratio`, `dq_failures_total{check}`.
- **Usage events** (`usage_events`, FUNC-04): `fn.launch`, `fn.param`, `fn.page`, `fn.export`, `fn.help`, `search.select`,
  `cmd.parse_error`, `panel.switch`, `ws.subscribe`, `ws.slow`, `ws.resync`, `ticket.open`; columns `user_id, panel_id, code,
  params_hash, instrument_id, duration_ms, trace_id, ts`; batched writer. The roadmap query is
  `SELECT code, count(*) FROM usage_events WHERE kind='fn.launch' AND ts > now()-interval '30 days' GROUP BY 1 ORDER BY 2 DESC`.
- **Data quality** (`dq_events`, OPS-03, QA-03): stale tick (hot subject with frozen `ts.src` > 3 × interval during `open`),
  cross-source divergence (Cboe vs Yahoo > 0.5 %), missing close (no `PX_OFFICIAL_CLOSE` / `bars_daily` row for a hot
  instrument by 18:30 ET), field-population rate per adapter run, poll anomaly (identical `seqno` for > 30 min in `open`),
  provider circuit open. Surfaced on `GET /api/v1/status` and the `sys:status` subject (OPS-04).

---

## 12. Runtime topology

Single Node 22 process per environment: Fastify HTTP and the `ws` server share port 8080; the ticker
plant, scheduler, conflators and access-log/usage writers are in-process modules; Postgres 14 is the
only stateful dependency; no message broker. The module boundaries that would become process
boundaries later are already typed interfaces: `PlantReader`/`PlantBus` (plant), `ProviderRegistry`
(providers), `EntitlementService` (entitlements), `SubscriptionSink` (ws). Multi-region PoPs (NFR-03)
and multi-datacentre feed redundancy (FEED-09) are out of v1 scope per BRIEF §1.

```
npm run dev      concurrently: server (tsx watch packages/server/src/index.ts, :8080)
                               web    (vite, :5173, proxy /api → :8080, /ws → ws://:8080)
npm test         PROVIDER_MODE=replay DATABASE_URL=…/bloomberg_test — unit + integration + replay + parity + component tests, offline
npm run test:live  PROVIDER_MODE=live — exercises real providers (optional, never in CI)
npm run e2e      Playwright spawns the replay-mode server against bloomberg_test
```

Processes and data-flow direction: providers → (HttpClient) → normalisers → plant → WS sessions → SDK →
grid; providers → normalisers → Postgres → data services → function runner → SDK → screens; both paths
stamp provenance and pass the same entitlement evaluator.

### 12.1 Startup order (`packages/server/src/index.ts`)

1. `config.ts` parses env (fail fast on missing `DATABASE_URL`, `SEC_USER_AGENT`, `SESSION_SECRET`).
2. `db/client.ts` connects; pending migrations → exit 1 with the list (`npm run db:migrate` applies them).
3. Load `licence_registry` + `field_licence` into `entitlements/licenceRegistry.ts`; load the field dictionary; validate every `field_licence.field_id` exists in the dictionary (exit 1 otherwise).
4. Load calendars (`refdata/calendars.ts`) and the function registry; `gen-function-index` consistency check (every manifest has a server module).
5. Build the universe search snapshot (`search/snapshot.ts`) and its ETag.
6. Warm the plant (`plant/warm.ts`) from the latest `quote_snapshots` per hot instrument, marking every subject `stale` until the first live/replayed poll succeeds, so screens are never blank and never falsely live (TERM-12).
7. Start the WS gateway and HTTP listener (`buildApp(deps).listen(8080)`); `/api/v1/health` returns `starting` until step 8.
8. Acquire the ingest leader lock and start the scheduler; priority-1 jobs run immediately, then `/health` returns `ok`.
9. Start the access-log, usage-event and DQ writers and the 1 s staleness sweep.

Shutdown (SIGTERM): stop the scheduler, release the leader lock, send `bye 1001` to every WS session,
flush access-log and usage buffers, drain the pool, exit. Clients reconnect with backoff and resync
through fresh snapshots (BUS-07, OPS-02 for the single supported protocol version 1).

---

## 13. How tagged requirements are honoured

| Tag | Requirement | Mechanism that cannot be bypassed |
| --- | --- | --- |
| [Correctness] | STOR-06 point-in-time | `fundamentals.facts(…, knownAt)` has no overload without `knownAt`; `xbrl_facts.filed_at` filter is inside the service; FA/EE payloads echo `meta.asOf.knownAt`; `server/test/integration/pit.fundamentals.test.ts` inserts a restatement and proves the earlier `knownAt` returns the original. |
| [Correctness] | TERM-12 staleness | `ValueState` is part of `QuoteState`, every WS frame (`st`) and every `Cell`; computed by one function (`core/quote/staleness.ts`) on server and client; recomputed every second client-side; a value with `ts.cap = 0` is `blank`; provider circuit-open marks subjects `stale`; grid renders `stale` in a distinct colour and glyph. |
| [Correctness] | ANAL-08 reproducibility | `defineEngine` forces `{ inputs, outputs, engine:{name,version}, valuationTs, inputsHash }`; MC uses a seeded PRNG; no `Date.now()` in core; golden datasets under `fixtures/golden/analytics` pin outputs (QA-01, ANAL-09); payloads carry `meta.engines[]`; `replay:diff` catches drift. |
| [Correctness] | API-05 identical values | One data path: web cannot bypass the SDK (§1.1); screen, CSV and API read the same cached `resultId` payload; `toCsv` in core is the only serialiser; `server/test/parity/fn-parity.test.ts` runs every manifest through resolver → JSON → CSV → WS snapshot at a frozen clock and asserts numeric equality. |
| [Regulatory] | DATA-09 licence registry | Evaluator rule 1–3 read only `licence_registry`/`field_licence`; export and API usage flags live there; retention comes from there. |
| [Regulatory] | ENTL-01 server-side entitlements | `evaluate()` precedes every data-service call and every WS `sub`; guard test in §10; client only renders reasons. |
| [Regulatory] | EXEC-01 (and EXEC-02..06) | Out of scope by BRIEF §1: no order routes exist; `MSG-06` structured trade messages are parsed for display only. |
| [Regulatory] | REG-01 books and records (SEC 17a-3/17a-4) and MSG-02 (SEC 17a-4 / FINRA 3110) | `messages` is append-only: the app role has no UPDATE/DELETE grant; rows are hash-chained (`prev_hash`, `hash`); `legal_holds` and `surveillance_hits` tables; `access_log` retention ≥ 7 years; production on request = `GET /api/v1/admin/export/messages?room&from&to`. |
| [Regulatory] | REG-02 benchmark regulation (EU BMR) | No index or benchmark is published; curves (`c:UST_PAR`, `c:SOFR_OIS`) are labelled derived from official Treasury/NY Fed inputs with `attribution` and are not redistributed (`licence_registry.redistribution=false`). Recorded as out of scope with reason. |
| [Regulatory] / [Privacy] | REG-04 GDPR/CCPA | Personal data is limited to `users` (name, email, WebAuthn credential) and `people` (public officers from SEC filings); `docs/DATA_MODEL.md` documents lawful basis per column; `DELETE /api/v1/admin/users/:id` anonymises while preserving `access_log` integrity (legal obligation). |
| [Regulatory] | REG-05 market abuse (MAR), REG-06 sanctions, REG-07 residency, REG-08 DORA | Mechanism-level only: lexicon surveillance on chat (`messaging/surveillance.ts`), single-region deployment, no sanctions screening — recorded as gaps in TRACEABILITY.md. |
| [Regulatory] | SEC-01/02/03 identity | Accounts bound to a person; WebAuthn (FIDO2) supported with password as dev fallback; single active session enforced (§10 step 7). SSO/SCIM out of scope. |
| [Blocker] | DATA-01 licensing | Cannot be met by software; the registry records the actual public-source terms, the evaluator refuses `redistribution` and `non_display` unless granted, and the declarations query exists so a licensed venue plugs in without changing the mechanism. |
| [Sales blocker] | SEC-07 SOC 2 / ISO 27001 | Out of scope; the controls it audits (TLS termination in front, session hashing with pgcrypto, RLS tenant isolation, access log, immutable messages) are built so certification can follow. |
| [Cannot be retrofitted] | REF-03 bitemporal | Bitemporal column block + exclusion constraint + guard trigger on every reference/fundamentals/licence table from the first migration; `asOf()` is the only read predicate offered by `refdata/*` repositories; no non-bitemporal master exists to migrate later. |
| [Architecturally load-bearing] | FEED-03 normalisation model | `NormalisedUpdate`/`QuoteState`/`Instrument` in `@terminal/core` are the only shapes adapters emit and the plant, WS, SDK, grid and chart accept; raw provider shapes are known only inside `providers/<name>/parse.ts`. |
| [High effort] | TERM-08 live grid | Own work package with the frame-budget test in §6.6 and the Playwright perf spec; DOM cells updated imperatively outside React. |
| [Existential] | PORT-07 tenant isolation (and SEC-05) | `portfolios`, `positions`, `lots`, `portfolio_imports`, `messages`, `workspaces` carry `firm_id`/`owner_user_id`; Postgres row-level security policies keyed on `current_setting('app.firm_id')`/`app.user_id`, set per request transaction in `db/client.ts`; `server/test/integration/tenant-isolation.test.ts` attempts cross-tenant reads as another firm and expects zero rows; the app role cannot bypass RLS. |
| [Trust] | NEWS-08 machine-generated content | No LLM summarisation or extraction exists in v1; `news_items.machine_generated` and the `ValueState 'na'` render class exist so a future generated field can never share the numeric hierarchy; missing consensus numbers (EE) are `meta.unavailable[]` with a reason code, never a generated value. |
| [Strategic] / [Decision gate] | MSG-05 federation, SCOPE-05 build/buy | Decided in BRIEF §1 (no federation, everything built); recorded in TRACEABILITY.md as out of scope with reason. |
| [SEC 15c3-5] | EXEC-04 pre-trade risk | Out of scope with EXEC-*. |
| [DORA / FCA CTP] | REG-08 | Out of scope; status endpoint and DR notes only. |

---

## 14. Work-package boundaries implied by this document

Each row is implementable in isolation from the interfaces above; the only shared prerequisite is WP-01.

| WP | Owns | Interfaces it must honour |
| --- | --- | --- |
| WP-01 | root tooling, eslint boundaries, generators, `core/types/*`, `core/clock.ts`, `sdk/wire/*` | §1.1, §4, §6.4 |
| WP-02 | `core/ids`, `core/calendars`, `core/daycount`, `core/command`, `core/search`, `core/formula` | §5 parse rules, `SecurityRef` |
| WP-03 | `core/analytics/*`, `core/adjust`, golden datasets | `defineEngine`, `AdjustPolicy` |
| WP-04 | migrations, `db/*`, `refdata/*`, `data/*` | §4.3 bitemporal block, `DataServices` |
| WP-05 | `providers/*`, `replayStore`, `provenance`, fixtures manifest, normaliser goldens | `NormalisedUpdate`, §8.1 keys |
| WP-06 | `ingest/*`, `hotset`, DQ monitors, reconcile | §7.1 job contract |
| WP-07 | `plant/*`, `ws/*`, `core/quote/*` | §6.2–6.5 |
| WP-08 | `entitlements/*`, `auth/*`, quotas, declarations, RLS | §10 |
| WP-09 | `functions/runner`, `context`, `resultCache`, `export`, routes, observability | §5, §11 |
| WP-10 | function manifests + resolvers + screens, Tier 1 then 2 then 3 | §5.2, `ResolveContext` |
| WP-11 | `web/shell`, `keyboard`, `command`, `state`, `screen/ScreenRenderer` | §5 lifecycle |
| WP-12 | `web/grid` (TERM-08), `web/rt`, `sdk/client` | §6.6 |
| WP-13 | `web/chart` | `ChartSpec` in FUNCTIONS.md |
| WP-14 | `seed/*`, `e2e`, TESTING.md harnesses, replay harness | §8.2, §12 |

---

## 15. Decision log (where the candidates disagreed)

| Topic | Chosen | Why (one line) |
| --- | --- | --- |
| Internal instrument key | `instrument_id bigint` (A, B) not FIGI string (C) | Rates, econ series and T-bills have no FIGI; REF-01 says the internal id must be ours and immutable, with FIGI as one cross-reference. |
| Subject separator | `q:<id>` (A, B) not `q/<id>` (C) | Two of three candidates and the SDK regex already used it; nothing else depends on the character. |
| Delta ordering | `prev` chain (C) not `skipped` count (B) or `n` (A) | `prev === lastSeq` detects loss with one comparison and no arithmetic on conflated gaps. |
| Timestamps on the wire | epoch ms numbers (B, C) not ISO strings (A) | Four bytes shorter per field at 10 000 subscriptions and directly comparable in the client staleness ticker. |
| Staleness vocabulary | `live/stale/closed/blank/na` with tier carried separately (A + C merged) | Tier and freshness are orthogonal; "delayed" as a staleness state (C) conflated them and B's four-level ladder added states no screen renders differently. |
| Backpressure ladder | C's byte thresholds with A's overload floor | Byte-based checks at flush time need no extra timers and map one-to-one to wire notices. |
| Concurrent sessions | new login supersedes the old one with `4003` (A, B) not a restricted third mode (C) | A "restricted" session is a third tier-state every screen must handle; supersede-and-log satisfies ENTL-03/SEC-03 with one rule. |
| Bitemporal exclusion | current-version-only exclusion + guard trigger (A) not double-range exclusion (C) | Closed transaction versions legitimately overlap in valid time; excluding them would forbid corrections. |
| Provenance column name | `provenance_id` (A) not `prov_id` (B, C) | Matches BRIEF wording and the `provenance` table name; no abbreviation to learn. |
| Licence registry table | `licence_registry` + `field_licence` (B, C) not `sources`/`source_fields` (A) | The requirement is called a licence registry; naming the table after it makes the audit conversation shorter. |
| Field dictionary home | `core/fields/dictionary.ts`, generated JSON in sdk (B, C) not sdk-owned with a build step into core (A) | Keeps the dependency direction strictly `core ← sdk`. |
| Autocomplete | local universe index with server fallback (B, C) not server-first (A) | 80 ms p95 per keystroke is not achievable through a network hop on every key. |
| Live grid rendering | DOM cells updated imperatively (A, C) not canvas (B) | TERM-06 keyboard operability, focus and text selection come free with DOM; canvas would reimplement them. |
| Export equality | cached `resultId` payload (B) with re-resolve at `meta.asOf` as fallback (A) | Live plant values are not bitemporal, so only the cached payload can guarantee screen = CSV; re-resolve covers expiry for stored data. |
| Trace id format | UUID v4 via `crypto.randomUUID()` (A) not ULID (B) or 16 hex (C) | Zero dependencies in browser and Node 22; sortable ids are not needed because `ts` is stored alongside. |
| Function-only with no security | error `NO_SECURITY_LOADED` (B) not default to `DES` | Silently launching on nothing hides the user's mistake; security-only still defaults to `DES`. |
| Scheduler leader lock | advisory lock (C) kept even in single-process v1 | Costs one query at startup and makes a second dev process safe. |
| HTTP prefix | `/api/v1` and `/ws/v1` (B, C) not `/v1` (A) | Vite proxy rules and a future static host need one unambiguous prefix. |
