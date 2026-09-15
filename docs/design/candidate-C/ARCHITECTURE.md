# ARCHITECTURE — candidate C ("real-time, analytics & API first")

Companion documents: [DATA_MODEL.md](./DATA_MODEL.md), [API.md](./API.md), [FUNCTIONS.md](./FUNCTIONS.md),
[PROVIDERS.md](./PROVIDERS.md), [CLIENT.md](./CLIENT.md), [TESTING.md](./TESTING.md), [WORKPLAN.md](./WORKPLAN.md),
[TRACEABILITY.md](./TRACEABILITY.md). The BRIEF's decisions (wedge, stack, layout, contracts, catalogue, sources)
are taken as fixed and are not restated except where a concrete mechanism is derived from them.

## 0. The one design rule

**A number exists once.** It is produced by one pure function in `@terminal/core` (analytics) or by one server
data service (market/reference/fundamental data), it travels as a raw JSON number with its provenance id, its
`asOf` pair and its staleness state, and it is formatted by one formatter (`@terminal/core/fields/format`).
The terminal, the REST API, the WebSocket feed and the CSV export are four *views* of the same value; none of
them computes anything of its own. Every trade-off below is resolved in favour of this rule.

Consequences that shape everything else:

| Consequence | Mechanism |
| --- | --- |
| Terminal and API cannot disagree (API-05) | `packages/web` is forbidden from calling `fetch`/`WebSocket` directly (ESLint `no-restricted-globals` + a unit test that greps the bundle). All data enters the client through `@terminal/sdk`, which is also the public client. |
| Screen and CSV show the same numbers (FUNC-03) | `toCsv(payload)` lives in `@terminal/core/functions/<code>` and is executed by the **server** for `/api/v1/fn/:code/csv` and by the client for local export, on the same payload object. |
| Analytics reproducible forever (ANAL-08) | Engines are pure, take an explicit `valuationTs`, seed their own PRNG, and return `{inputs, outputs, engine: {name, version}}`. Payloads embed `asOf` and engine versions. |
| Every value has provenance (DATA-10) | Every stored row and every composite field carries a `prov_id` → `provenance` table → raw response hash → replay store file. |
| Real-time is honest (TERM-12, BUS-03) | The ticker plant is the *only* source of live values; conflation never drops the latest value; the client re-derives staleness on a 1 s clock from the three timestamps it received. |

## 1. System overview

```
                       ┌──────────────────────────────────────────────────────────────────┐
                       │                         packages/server                          │
  public sources       │  ┌────────────┐   ┌─────────────┐   ┌──────────────────────────┐ │
  (OpenFIGI, Cboe,     │  │ providers/ │──▶│ normalisers │──▶│ ticker plant (in-memory)  │ │      ┌──────────────┐
   Yahoo, SEC, FRED,   │  │ + HttpClient│  │ (pure, core │   │ composite | subjects |    │─WS──▶│  @terminal/  │
   NY Fed, Treasury,   │  │ live/replay│   │  types)     │   │ conflator | policy | hot  │ │      │  sdk (WS +   │
   BLS, WB, IMF, FX)   │  └─────┬──────┘   └──────┬──────┘   └────────────┬─────────────┘ │      │  REST client)│
                       │        │ raw+prov        │ rows                  │ eod snapshots │      └──────┬───────┘
                       │  ┌─────▼──────────────────▼──────┐   ┌───────────▼─────────────┐ │             │
                       │  │ replay store (fixtures/…)      │   │ Postgres 14 (Drizzle)    │ │      ┌──────▼───────┐
                       │  └───────────────────────────────┘   │ bitemporal ref, bars,    │ │      │ packages/web │
                       │  ┌───────────────────────────────┐   │ ticks, facts, news, …    │ │      │ terminal     │
                       │  │ scheduler / ingest jobs        │   └───────────┬─────────────┘ │      │ (React 19)   │
                       │  └───────────────────────────────┘               │               │      └──────────────┘
                       │  ┌─────────────────────────────────────────────────▼───────────┐ │
                       │  │ data services ─ function runtime ─ REST (Fastify 5) ─ auth   │─REST─▶ external users
                       │  │ entitlement engine ─ access log ─ quotas ─ usage events      │ │        (same SDK)
                       │  └──────────────────────────────────────────────────────────────┘ │
                       └──────────────────────────────────────────────────────────────────┘
   packages/core: pure domain (types, ids, calendars, day counts, analytics, formula, command grammar,
                  manifests, field dictionary, formatters, CSV) — imported by server, sdk and web. No IO.
```

Single process in v1 (Fastify HTTP + `ws` on the same port), single Postgres. The plant is an in-process
module; the design keeps it behind an interface (`PlantPort`) so it could move out of process, but nothing in
v1 requires that.

## 2. Package boundaries and module list

### 2.1 `packages/core` (`@terminal/core`) — pure, no IO, no Node APIs

| Path | Responsibility |
| --- | --- |
| `src/types/instrument.ts` | `AssetClass`, `MarketSector`, `Issuer`, `Issue`, `Instrument`, `Listing`, `MdLine`, `InstrumentRef`, `ResolvedRef` |
| `src/types/quote.ts` | `QuoteFields`, `Composite`, `Timestamps3`, `Tier`, `SessionState`, `ValueState`, `NormalisedUpdate` |
| `src/types/fields.ts` | `FieldId`, `FieldDef`, `FieldClass`, `FieldValue` |
| `src/types/provenance.ts` | `ProvRef`, `ProvenanceRecord`, `LicenceEntry` |
| `src/types/entitlement.ts` | `UsageType`, `Decision`, `DowngradeReason` (closed enum) |
| `src/types/function.ts` | `FunctionManifest`, `Payload<T>`, `CsvSpec`, `ResolveContext` (type only), `SubjectSpec` |
| `src/ids/figi.ts`, `src/ids/instrumentId.ts`, `src/ids/occ.ts` | FIGI check digit, `TRM…` minting, OCC option symbol parse/format |
| `src/calendars/{nyse,sifma,usgovt,target,index}.ts` | Holiday rules 1990–2040, `isBusinessDay`, `addBusinessDays`, `combine(cal[])` (REF-06) |
| `src/daycount/{conventions,businessDay}.ts` | ACT/ACT ICMA, ACT/ACT ISDA, ACT/360, ACT/365F, 30/360 US, 30E/360; Following/ModFollowing/Preceding |
| `src/analytics/engine.ts` | `EngineResult<I,O>`, `defineEngine(name, version, fn)`, seeded PRNG (`mulberry32`) |
| `src/analytics/bill.ts` | T-bill discount↔price↔BEY (≤182d and >182d formulas) |
| `src/analytics/bond.ts` | Street-convention price/yield, accrued, Macaulay/modified duration, convexity, DV01, key-rate durations |
| `src/analytics/curve.ts`, `interp.ts` | Par→zero bootstrap, OIS discount curve from SOFR fixings/OIS quotes, forwards, interpolation (linear-zero, log-linear-DF, monotone-convex) |
| `src/analytics/swap.ts` | SOFR OIS swap schedule, compounding, PV, par rate, DV01, annuity |
| `src/analytics/options.ts`, `tree.ts`, `mc.ts` | BSM (with q), Black-76, greeks, implied vol; CRR/trinomial American; MC antithetic+control-variate |
| `src/analytics/volsurface.ts` | Chain → smile per expiry, forward inference from put-call parity, SVI fit, butterfly/calendar arbitrage checks |
| `src/analytics/stats.ts` | returns, vol, corr, beta, OLS, drawdown, Sharpe/Sortino/IR (documented conventions) |
| `src/analytics/wirp.ts` | Implied policy path from OIS/T-bill forwards between FOMC dates |
| `src/analytics/portfolio.ts` | Exposure, Brinson attribution, ex-post tracking error, historical/parametric VaR, scenario shocks |
| `src/analytics/adjust.ts` | Corporate-action adjustment factors on read (policy: `none`/`split`/`split_div`/`total_return`) |
| `src/formula/{lexer,parser,eval}.ts` | Formula language for computed series (CHRT-07) |
| `src/command/{grammar,parser,sectors}.ts` | Command grammar `[SECURITY] [SECTOR] [FUNCTION] [ARGS]` |
| `src/search/{rank,index}.ts` | Autocomplete ranking + in-memory prefix/trigram index |
| `src/fields/{dictionary,format}.ts` | The field dictionary (versioned) and the single formatter |
| `src/functions/manifest.ts`, `registry.ts`, `tier1/*.ts`, `tier2/*.ts`, `tier3/*.ts` | Manifests: code, aliases, params (zod), payload types, `toCsv`, help |
| `src/csv/write.ts` | RFC 4180 writer, numeric cells at 15 significant digits |
| `src/staleness.ts` | `valueState(ts, tier, session, now)` — one implementation, used by server and client |

### 2.2 `packages/sdk` (`@terminal/sdk`) — typed client, wire types, registry

| Path | Responsibility |
| --- | --- |
| `src/wire/{rest,ws,errors}.ts` | zod schemas for every request/response and WS message (the wire contract) |
| `src/client/rest.ts` | `TerminalClient`: `data(request)`, `fn.run/csv`, `search`, `ref.resolve`, workspace/watchlist/portfolio/message/alert APIs |
| `src/client/ws.ts` | `LiveClient`: connect/hello, subscribe with field masks, per-subject seq tracking, resync, reconnect with backoff, downgrade notices |
| `src/client/subscriptions.ts` | Ref-counted subscription manager; batching of `sub`/`unsub`; viewport windows |
| `src/registry/index.ts` | Function registry = core manifests + lazy `Screen` loaders (web) |
| `src/fields/index.ts` | Re-export of the dictionary + `format()` |
| `src/index.ts` | Public surface for external users (Node and browser) |

### 2.3 `packages/server` (`@terminal/server`)

| Path | Responsibility |
| --- | --- |
| `src/index.ts`, `src/app.ts`, `src/config.ts` | Bootstrap, Fastify app factory (`buildApp(deps)`), typed env config |
| `src/db/{client,asOf,partitions}.ts`, `src/db/schema/*.ts`, `src/db/migrations/*.sql` | Drizzle schema, committed SQL migrations, `asOf()` helper, partition manager |
| `src/http/{client,live,replay,record}.ts` | `HttpClient` interface; live (undici), replay (fixtures only), record (live + write fixtures) |
| `src/providers/adapter.ts`, `registry.ts`, `licences.ts`, `<provider>.ts` | Adapter contract, per-provider adapters, licence registry seed |
| `src/plant/{plant,composite,subjects,conflator,session,policy,staleness,hotset,eod}.ts` | Ticker plant |
| `src/ws/{gateway,protocol,auth}.ts` | WebSocket gateway (`/ws`), message codec, auth handshake |
| `src/auth/{routes,session,password,webauthn,apikeys}.ts` | Login, sessions, WebAuthn, API keys, concurrent-session control |
| `src/entitlement/{evaluate,registry,accessLog,quota,declarations}.ts` | Entitlement engine, batched access log, quotas, monthly declarations |
| `src/ref/{master,resolve,xref,bitemporal,corporateActions,calendars,indexMembership,universe}.ts` | Security master services |
| `src/data/{reference,historical,intraday,tick,snapshot,news,fundamentals,econ,curves,rates,options,portfolio}.ts` | Data services (one per request type / domain) |
| `src/functions/runtime.ts`, `src/functions/tier{1,2,3}/<CODE>.ts` | Function runtime and resolvers |
| `src/api/{routes/*.ts,envelope.ts,errors.ts,search.ts,export.ts,fields.ts,data.ts}` | REST routes |
| `src/ingest/{scheduler,lock,jobs/*.ts}` | Scheduler, advisory-lock leader election, job definitions |
| `src/ops/{tracing,metrics,dq,status}.ts` | Trace ids, Prometheus metrics, data-quality checks, status endpoint |
| `src/replay/{store,session,cli,diff}.ts` | Replay store, session replay harness, output diff |
| `src/seed/{index,universe,users,workspaces}.ts` | Seed |
| `src/test/{db,app,fixtures,clock}.ts` | Test harness (transactional DB, app factory, virtual clock) |

### 2.4 `packages/web` (`@terminal/web`)

| Path | Responsibility |
| --- | --- |
| `src/main.tsx`, `src/App.tsx` | Bootstrap; single `TerminalClient` + `LiveClient` from the SDK |
| `src/shell/{Shell,PanelGrid,Panel,CommandLine,Autocomplete,StatusBar,HelpOverlay,TicketDialog}.tsx` | Terminal shell |
| `src/keyboard/{keymap,dispatcher,focus}.ts` | Action keys, panel switching, focus rings |
| `src/state/{session,panels,subscriptions,workspace,settings}.ts` | zustand stores |
| `src/grid/{LiveGrid,GridCore,cellRegistry,virtualiser,sort,group,flash}.ts(x)` | Live grid |
| `src/chart/{ChartCanvas,renderer,layers,scales,series,studies/*,overlays,annotations,events,streaming}.ts(x)` | Canvas chart |
| `src/screens/tier{1,2,3}/<CODE>/Screen.tsx` | Function screens |
| `src/format/` | thin wrappers around core `format()` (no arithmetic) |
| `src/theme/{tokens.css,colours.ts}` | Semantic colours and density type stack |

### 2.5 `packages/e2e` — Playwright specs, `fixtures/` — replay store, golden datasets, seed inputs.

## 3. Request lifecycle: keystroke → command parse → function resolve → data → screen

```
 t0   keydown 'A' in CommandLine (panel 2)
      ├─ panelsStore.setInput(2, 'A')                 sync, React state (≤1 frame; budget < 16 ms)
      └─ searchIndex.query('A', ctx)                  in-memory core/search (≈40k instruments + 40 functions
                                                       + people + topics), returns ≤ 8 ranked hits in < 5 ms;
                                                       server /api/v1/search only for name queries ≥ 3 chars
                                                       missing locally (debounced 60 ms, budget 80 ms p95)
 t1   <GO> (Enter)
      ├─ parseCommand('AAPL US Equity GP', panelCtx)   core/command → { security:'AAPL US', sector:'Equity',
      │                                                 fn:'GP', args:{} } (function-only / security-only rules,
      │                                                 FUNCTIONS.md §2)
      ├─ sdk.ref.resolve({ticker:'AAPL', exchCode:'US', sector:'Equity'})
      │       cache hit → ResolvedRef{instrumentId:'BBG000B9XRY4', assetClass:'equity', …}
      │       miss → GET /api/v1/ref/resolve (security master; OpenFIGI on miss, then Yahoo search fallback)
      ├─ panelsStore.navigate(2, {fn:'GP', security, params})  pushes onto the panel back-stack
      └─ sdk.fn.run('GP', {security, params, traceId})
              POST /api/v1/fn/GP  (x-trace-id)
 t2   server functions/runtime.ts
      ├─ manifest = registry.get('GP'); params = manifest.params.parse(body.params)   (zod)
      ├─ polymorphism: pick resolver variant by resolved.assetClass (GP.equity / GP.govt / GP.fx …)
      ├─ entitlement.evaluate(user, instrument, fieldClass:'price', tier:'delayed', usage:'display')
      ├─ ctx = { traceId, user, asOf:{valuationTs, knownAt}, data, entitlement, prov: collector, usage }
      ├─ payload = await resolve(ctx, params)      data services → Postgres / plant / providers-on-demand
      ├─ usage.emit('fn.launch', {code, params, security, traceId})                      (FUNC-04)
      └─ reply Payload<GPData> { data, asOf, provenance[], staleness, entitlement:{tier, downgrades}, traceId }
 t3   client Screen('GP')(payload)
      ├─ first paint of static data (budget 500 ms p95 from t1 for Tier 1)
      ├─ manifest.subjects(payload) → ['q/BBG000B9XRY4', 'b1/BBG000B9XRY4']
      └─ subscriptions.acquire(subjects, fields) → WS 'sub' → 'snap' → 'delta' …  (see §4)
 t4   HELP → HelpOverlay(manifest.help, field defs of visible fields); second HELP within 10 s → TicketDialog
```

Function-only input (`GP`) reuses `panel.security`; security-only input (`MSFT US Equity`) reuses
`panel.fn` (TERM-03). Both are decided in `core/command/parser.ts` given the `PanelContext`.

## 4. Real-time lifecycle: provider poll → normaliser → ticker plant → conflated WS → grid cell flash

### 4.1 Composite state (BUS-01)

`plant/composite.ts` keeps one `Composite` per **subject**. Subject key grammar (`plant/subjects.ts`):

| Prefix | Meaning | Example |
| --- | --- | --- |
| `q/{instrumentId}` | Quote composite for an instrument (equity, etf, index, fx, govt, option, crypto) | `q/BBG000B9XRY4` |
| `b1/{instrumentId}` | Streaming 1-minute bar (current bar updates, new bar rolls) | `b1/BBG000B9XRY4` |
| `oc/{instrumentId}` | Option-chain summary for an underlying (expiries, ATM IV, counts); per-contract quotes are `q/…` | `oc/BBG000B9XRY4` |
| `cv/{curveId}` | Curve (par points, build id) | `cv/UST_PAR` |
| `rt/{rateId}` | Rate fixing (SOFR, EFFR, OBFR, TGCR, BGCR, SOFRAI) | `rt/SOFR` |
| `ec/{seriesId}` | Econ series latest observation/release | `ec/CPIAUCSL` |
| `nw/{scope}` | Headline stream: `all`, `feed:markets`, `inst:{instrumentId}`, `topic:{id}` | `nw/inst:BBG000B9XRY4` |
| `sys/status` | Provider health, market session state, server clock | `sys/status` |

```ts
// packages/core/src/types/quote.ts
export type Tier = 'realtime' | 'delayed' | 'eod';
export type ValueState = 'live' | 'delayed' | 'stale' | 'closed' | 'blank' | 'na';
export interface Timestamps3 { src: number | null; cap: number; pub: number }      // epoch ms (FEED-05)
export interface Composite {
  subject: string; instrumentId: string | null; assetClass: AssetClass;
  seq: number;                       // per-subject, +1 on every applied change
  tier: Tier;                        // tier of the source line feeding this composite
  fields: Record<FieldId, number | string | null>;
  fieldTs: Record<FieldId, number>;  // src ts (or cap when src absent) of the last change per field
  ts: Timestamps3;                   // of the last applied update
  prov: ProvRef;                     // provider, provenance id, source seqno
  session: SessionState;             // pre|open|halted|auction|closed|post|unknown
}
```

`Composite` is the truth. There is no delta log: recovery is always a fresh snapshot (BUS-07), which is
gap-free and duplicate-free by construction.

### 4.2 Ingest path

```
hotset.ts  decides which subjects are polled: union of (subjects with ≥1 WS subscriber) ∪ (watchlist members
           of connected users) ∪ (seed "always-on" set: WEI indices, VIX, benchmark Treasuries, G10 FX).
           Subjects without subscribers decay out of the hot set after 300 s.
jobs/cboeQuotes.ts   every 15 s: batches of hot equity/etf/index/option subjects, concurrency 4,
                     token bucket 4 req/s (PROVIDERS.md)
     → HttpClient.get(url) → RawRecord{ bytes, status, headers, capturedAt, sha256 }
     → replayStore.put(raw) (when RECORD=1) ; provenance.insert(raw) → provId
     → adapter.parse(raw): NormalisedUpdate[]   (pure; fuzzed in tests)
     → plant.apply(update)
```

```ts
// packages/core/src/types/quote.ts
export interface NormalisedUpdate {
  subject: string; instrumentId: string | null; assetClass: AssetClass; tier: Tier;
  fields: Partial<Record<FieldId, number | string | null>>;
  ts: Timestamps3;                       // src from provider (last_trade_time / seqno), cap = fetch time
  prov: ProvRef;                         // { provider:'cboe.quotes', provId: 123456, srcSeq: 15972883317 }
  session?: SessionState;
}
```

`plant.apply` (in `plant/plant.ts`):

1. `rec = table.get(subject) ?? create(update)`.
2. `changed = fields whose value differs from rec.fields` (NaN-safe, `null` counts as a value).
   Cboe `seqno` is compared first: an update whose `srcSeq <= rec.prov.srcSeq` is a **replay of stale data**
   and is dropped with metric `plant_updates_dropped_total{reason="stale_seq"}` (no silent gap-fill, FEED-02
   analogue for HTTP polling).
3. If `changed` is empty: refresh `rec.ts.cap` only (feeds staleness), no `seq` increment, no fan-out.
4. Else: `rec.seq += 1`; merge fields; `fieldTs[f] = ts.src ?? ts.cap`; `rec.ts = {src, cap, pub: now()}`;
   `rec.prov = update.prov`.
5. For every session subscribed to `subject`: `session.conflator.mark(subject, changedMask)`.
6. `metrics.plant_publish_latency_ms.observe(pub − cap)` (budget < 1 ms p99 in-process).

Field masks are `Uint32Array` bitsets over the dictionary's field index, so BUS-02 granularity is per field
and the per-update fan-out cost is O(subscribers) bit-ors.

### 4.3 Subject pub/sub, conflation (BUS-02/03) and sequencing

Per WS session (`plant/session.ts`):

```ts
interface Subscription { subject: string; fieldMask: Uint32Array; lastSentSeq: number; tier: Tier; essential: boolean }
class Conflator {
  intervalMs: number;                        // requested by client (hello.conflationMs), default 250, min 50, max 5000
  effectiveMs: number;                       // may be widened by backpressure
  dirty = new Map<string, Uint32Array>();    // subject → changed-field mask since last flush (insertion order)
  mark(subject, mask) { or-into dirty; arm timer if not armed }
  flush() {
    if (ws.bufferedAmount > HARD_BYTES) { /* keep dirty; try next tick */ return; }
    const frames = [];
    for (const [subject, mask] of dirty) {
      const rec = plant.get(subject); const sub = subs.get(subject);
      const view = policy.view(rec, sub.tier);                // tier policy (BUS-06)
      const fields = pick(view.fields, mask & sub.fieldMask); // latest values only
      frames.push({ t:'delta', s: subject, seq: view.seq, prev: sub.lastSentSeq, f: fields, ts: view.ts, st: view.state });
      sub.lastSentSeq = view.seq;
    }
    dirty.clear(); ws.send(encode({ t:'batch', m: frames }));
  }
}
```

Guarantees, and how they are tested (TESTING.md §5):

* **Latest value never dropped**: values are read from the composite at flush time; a subject stays dirty until
  it is flushed; a flush that cannot send (hard backpressure) leaves the dirty set intact.
* **Rate**: at most one `batch` frame per session per `effectiveMs`; a subject appears at most once per batch.
* **Ordering**: `delta.prev` equals the `seq` the server last sent this session for this subject. The client
  applies a delta iff `prev === lastSeq[subject]`, ignores it iff `seq <= lastSeq[subject]` (duplicate), and
  otherwise sends `resync` for that subject. Gaps in `seq` *values* are normal (conflation); gaps in the
  `prev` chain are not.
* **Snapshot-then-delta**: a `sub` always answers with `snap` (full field set of the subscribed mask, `seq`)
  before any `delta` for that subject; deltas marked dirty during snapshot construction are queued behind it.

### 4.4 Backpressure and slow consumers (BUS-04, NFR-02)

Thresholds (config, per session): `SOFT_BYTES=256 KiB`, `HARD_BYTES=2 MiB`, `GRACE_MS=10 000`, `MAX_MS=5000`.

| Condition (checked at every flush) | Action | Wire |
| --- | --- | --- |
| `bufferedAmount > SOFT` | `effectiveMs = min(effectiveMs*2, MAX_MS)` | `notice {kind:'slow-consumer', action:'conflation-widened', conflationMs}` |
| `bufferedAmount < SOFT/4` for 3 consecutive flushes | `effectiveMs = max(effectiveMs/2, requestedMs)` | `notice {action:'conflation-restored'}` |
| `bufferedAmount > HARD` | skip flush (dirty retained) | — |
| `bufferedAmount > HARD` continuously for `GRACE_MS` | shed non-essential subscriptions (those the client marked `essential:false`, i.e. off-viewport rows) → `status {st:'shed'}`; if still over after another `GRACE_MS` → close `4008 SLOW_CONSUMER` | `notice {action:'shed'}` / close frame |
| plant-wide overload (`ingest queue > 50k` or event-loop lag > 200 ms) | global `effectiveMs` floor raised (widen conflation for everyone), non-essential subjects shed first, last-price fields (`PX_LAST`, `CHG_*`) are never shed | `sys/status` delta `{plant:'degraded'}` |

Nothing is dropped silently: every shed/widen/close is a wire message and a metric.

### 4.5 Resync and reconnect (BUS-07)

1. Client reconnects with exponential backoff (250 ms → 8 s, jitter).
2. `hello {token, protocol:1, conflationMs, resume:true}` → `welcome {sessionId, serverTime, limits}`.
3. Client re-sends `sub` for all active subscriptions with `known: {subject: lastSeq}`. Server **always**
   answers with `snap` (full state, current `seq`) — it never tries to replay deltas — so application is
   idempotent and gap-free. Client replaces local state atomically per subject.
4. Mid-session `resync {subjects}` (client-initiated on a `prev` mismatch) or `resync` (server-initiated after a
   plant restart) → `snap` per subject.

### 4.6 Tier policy engine (BUS-06, ENTL-05)

`plant/policy.ts` derives every served tier from the same composite:

| Granted tier | View |
| --- | --- |
| `realtime` | Not available from any v1 source; requests are downgraded to `delayed` with reason `SOURCE_TIER_CAP`. The view function exists (identity on a realtime line) so that a future realtime line needs no protocol change. |
| `delayed` | Identity on Cboe/Yahoo lines (already ≥15 min delayed at source; the delay is *not* doubled). For a hypothetical realtime line the view reads from a per-subject 15-minute ring buffer (`plant/delay.ts`, shape only). |
| `eod` | `plant/eod.ts` snapshot: `PX_CLOSE`, `PX_PREV_CLOSE`, `VOLUME`, `PX_OPEN/HIGH/LOW` of the last completed session; `ts.src` = session close; other fields `null` with `reason:'TIER_EOD'`. |

Downgrades are emitted once per subscription as `downgrade {s, from, to, reason}` and repeated in every
`snap` (`tier` field) so a screen can always render the badge.

### 4.7 Client side

`sdk/client/ws.ts` maintains `lastSeq`, applies `snap`/`delta` to a local `Map<subject, Composite>` and
notifies subscribers with the changed field set. `web/grid/GridCore.ts` receives `(subject, changedFields)` and
updates the DOM directly (no React re-render): `cell.textContent = format(field, value)`, toggles
`.flash-up/.flash-down` (150 ms, removed on `animationend`), all coalesced into one `requestAnimationFrame`
per frame (CLIENT.md §5). Staleness is recomputed by a 1 s ticker using `core/staleness.ts` so a value that
stops updating visibly ages (TERM-12).

## 5. Ingest and scheduler

* `ingest/scheduler.ts`: in-process cron (`croner`-style spec evaluated each second), leader election through
  `pg_try_advisory_lock(hashtext('ingest-leader'))` so multiple server processes never double-run.
* Job definitions in `ingest/jobs/<provider>.ts` export `{ id, schedule, run(ctx) }`; each run is recorded in
  `ingest_run` (started, finished, records, error, provIds range). Failures back off exponentially (base 30 s,
  cap 1 h) and raise `dq_result` rows (OPS-03).
* Hot-set jobs (`cboeQuotes`, `cboeOptions`, `yahooIntraday`, `coingecko`) run at fixed short intervals on the
  hot set; universe jobs (`yahooDaily`, `secSubmissions`, `secCompanyFacts`, `fred`, `nyfed`, `treasury`,
  `fedH15`, `frankfurter`, `bls`, `worldbank`, `imf`, `finra`, `holdings`, `openfigiReconcile`) run on
  calendars in PROVIDERS.md §4.
* Every job is idempotent: upserts keyed on natural keys + `prov_id`; bitemporal tables receive new versions
  (`tx_from = now()`), never in-place updates.
* Data-quality checks (`ops/dq.ts`, OPS-03/QA-03): stale-tick (hot subject without a source change for > 20 min
  during `open`), cross-source divergence (Cboe `current_price` vs Yahoo `regularMarketPrice` > 0.5 % during
  open), missing close (no `bar_daily` row for a hot instrument by 18:30 ET), field-population rate per
  provider, message-rate anomaly (poll returned identical `seqno` for > 30 min in `open`). Results are rows in
  `dq_result` and a `sys/status` delta.

## 6. Replay harness (FEED-08, QA-02)

* **Replay store** (`fixtures/providers/replay/`, PROVIDERS.md §6): every raw HTTP exchange keyed by
  `{providerId}/{requestKey}` with request, response bytes (base64 or text), `capturedAt`, `sha256`.
  `ReplayHttpClient` serves *only* from the store and throws `ReplayMiss` (tests fail loudly, never touch the
  network). `RecordHttpClient` = live + write-through, used by `npm run fixtures:record`.
* **Session replay** (`replay/session.ts`): a *session* file lists replay keys in capture order with their
  `capturedAt`. `replay run --session S --speed 0` drives the scheduler with a virtual clock
  (`test/clock.ts`), feeds the plant through the real normalisers, and writes a **state log**: every applied
  composite change `(subject, seq, changedFields, ts)` plus every WS frame that a reference subscriber
  (subscribed to everything, conflation 0) would receive. `replay diff A B` compares two state logs and two
  sets of function outputs (`fn` matrix: every manifest × seed securities) and exits non-zero on any
  difference, printing the first divergence. Because normalisers are pure and clocks are virtual, two runs on
  the same store are bit-identical; a release candidate is compared against the previous release on the same
  sessions.

## 7. Provenance and licence registry (DATA-09/10)

* `provenance(id bigserial, provider_id, request_url, request_hash, response_sha256, captured_at, source_ts,
  licence_id, replay_key, http_status)` — one row per raw exchange. Every value-bearing row has `prov_id`.
  Composite fields carry `prov: {provider, provId, srcSeq}`; payloads list all `provenance[]` touched.
* `licence_registry(id, provider_id, source_name, terms_url, display, export, api, redistribution, derived,
  non_display, max_tier, retention_days, attribution, notes, valid_from, valid_to)`; seeded from
  `providers/licences.ts` (PROVIDERS.md §5); read by the entitlement engine on every decision; `retention_days`
  drives partition dropping (STOR-07).
* Field dictionary entries name their `source` providers, so `GET /api/v1/fields/:id` shows the licence that
  governs a field (API-07).

## 8. Entitlement evaluation (ENTL-01..06)

```ts
// packages/server/src/entitlement/evaluate.ts
evaluate(subject: { user, firm }, target: { instrumentId, assetClass, providerId, fieldClass },
         request: { tier: Tier, usage: 'display'|'export'|'api' }): Decision
// Decision = { granted: Tier | null; reason: DowngradeReason; licenceId; logId }
```

Order of evaluation (first failing rule decides; the result is cached per (user, provider, fieldClass, usage)
for 60 s, invalidated on entitlement/licence change):

1. `licence = registry[providerId]` — if `!licence[usage]` → `granted:null`, reason `LICENCE_NO_EXPORT` /
   `LICENCE_NO_API`.
2. `cap = min(licence.max_tier, user.entitlement(assetClass, fieldClass).tier, firm.contract(assetClass).tier)`
   — default `delayed` when no row exists (BRIEF §5.6).
3. If `request.tier > cap` → downgrade to `cap` with reason `NOT_ENTITLED_TIER` (user/firm cap) or
   `SOURCE_TIER_CAP` (licence cap). Never serve a stale higher-tier value (ENTL-05).
4. Person binding (ENTL-03/SEC-03): if another *active* session of the same user exists on a different device,
   the new session is `restricted` → real-time/delayed downgraded to `eod`, reason `CONCURRENT_SESSION`, until
   the other session ends or the user chooses "take over" (which revokes the other).
5. Quotas (API-06, `usage:'api'` only): daily unique securities, monthly datapoints, concurrent subscriptions
   → `QUOTA_EXCEEDED` (HTTP 429 / WS `err`).
6. `accessLog.record({user, instrument, fieldClass, tier, usage, purpose, ts, traceId})` — appended to an
   in-memory ring, bulk-inserted every 1 s or 5 000 rows (ENTL-04); the log is partitioned monthly and kept
   for `max(licence.retention_days, 7 years)`.
7. Monthly declarations (ENTL-06/DATA-02): `GET /api/v1/admin/declarations?month=YYYY-MM` runs one SQL over
   `access_log` grouped by licence × tier × usage × user, reconciled against `firm.seat_count`.

Enforcement point: the data services (`data/*.ts`) and the plant session (`ws/gateway.ts`) — never the client.

## 9. Observability (OPS-07, FUNC-04)

* **Trace ids**: `x-trace-id` accepted from the client (SDK generates 16 hex chars per user action) or minted
  by Fastify; propagated to pino child loggers, to `usage_event.trace_id`, `access_log.trace_id`, provider
  requests (`x-trace-id` outbound header where accepted, otherwise stored in `provenance.trace_id`) and returned
  in every payload (`payload.traceId`) and error envelope. A `HELP` overlay shows the last trace id so
  "why is this number wrong?" starts from one string.
* **Metrics** (`/metrics`, Prometheus text): `plant_updates_applied_total`, `plant_updates_dropped_total{reason}`,
  `plant_publish_latency_ms` (histogram), `ws_sessions`, `ws_subscriptions`, `ws_buffered_bytes` (gauge per
  session bucket), `conflation_effective_ms` (histogram), `provider_requests_total{provider,status}`,
  `provider_latency_ms`, `ingest_run_duration_ms`, `fn_resolve_ms{code}`, `db_query_ms{name}`,
  `dq_failures_total{check}`.
* **Usage events** (`usage_event`): `fn.launch`, `fn.param`, `fn.export`, `search.select`, `ws.subscribe`,
  `help.open`, `ticket.open`, with `panel`, `code`, `params_hash`, `security`, `duration_ms`.
* **Status** (`/api/v1/status`, OPS-04): provider health, last successful poll per job, plant degraded flag,
  market session per calendar, open dq incidents.

## 10. How requirement tags are honoured

| Tag | Requirement | Mechanism that cannot be bypassed |
| --- | --- | --- |
| Correctness | STOR-06 point-in-time | `fundamental_fact` is keyed on `filed_at`; the fundamentals service takes `knownAt` and filters `filed_at <= knownAt` **always** (no code path reads without it); FA/EE payloads echo `asOf.knownAt`. Test `pit.fundamentals.spec.ts` inserts a restatement and proves the earlier `knownAt` still returns the original. |
| Correctness | TERM-12 staleness | `ValueState` is part of every `FieldValue` and every WS frame (`st`); the client recomputes it every second from `ts`; the grid renders `stale` differently (CLIENT.md §7); a value with no timestamps is `blank`, never a number. |
| Correctness | ANAL-08 reproducibility | `defineEngine` forces `{inputs, outputs, engine:{name,version}, valuationTs}`; MC uses seeded PRNG; golden tests pin outputs; payloads embed engine versions; `replay diff` catches drift. |
| Correctness | API-05 identical values | Single data path (§0); parity test runs every function through resolver → JSON, → CSV, → WS snapshot at a frozen clock and asserts numeric equality. |
| Regulatory | DATA-09 licence registry | Entitlement rule 1 reads the registry; there is no data service entry point without an `evaluate()` call (enforced by a unit test that instantiates every service with a throwing entitlement stub and asserts every public method throws). |
| Regulatory | ENTL-01 server-side entitlements | Same; the client only *renders* `downgrade` reasons. |
| Regulatory | EXEC-01 | Out of scope (BRIEF non-goal); no order routes exist; `MSG-06` structured trade messages are parsed for display only. |
| Blocker | DATA-01 licensing | Cannot be met by software; the registry records display/non-display/derived/redistribution flags per public source and the declarations query exists so that a licensed venue could be plugged in without changing the mechanism. |
| Architecturally load-bearing | FEED-03 normalisation model | `NormalisedUpdate`/`Composite` in `@terminal/core` are the only shapes the plant accepts; adapters are the only place raw shapes are known. |
| High effort | TERM-08 live grid | Own work package (WP-14) with frame-time budget tests. |
| Existential | PORT-07 tenant isolation | Portfolio tables carry `firm_id` and `owner_user_id`; row-level security policies (`CREATE POLICY`) are enabled on `portfolio`, `position`, `portfolio_import`; every DB session sets `SET LOCAL app.user_id/app.firm_id`; tests attempt cross-tenant reads and expect zero rows. |
| Trust | NEWS-08 | No LLM summarisation exists in v1; the `news_item.machine_generated` flag and a distinct `ValueState 'na'` rendering class exist so that a future generated field can never share the numeric hierarchy. |
