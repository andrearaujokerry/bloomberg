# API — candidate B

All schemas below live in `packages/sdk/src/wire/rest.ts` and `packages/sdk/src/wire/ws.ts` as
zod v4 objects; the server validates requests *and* responses against them in dev/test
(`FASTIFY_VALIDATE_RESPONSES=1`), and the web client uses the same `RestClient`/`WsClient` as
external users (API-05: terminal and API cannot disagree). Base paths: REST `/api/v1`, WebSocket
`/ws/v1`. JSON only; numbers are JSON numbers (never strings) except ids which are strings.

---

## 1. Auth and session model

| Item | Decision |
| --- | --- |
| Identity | One `users` row per natural person; `firm_id` fixed. |
| Web login | `POST /auth/login` (password, dev/fallback) or WebAuthn (`/auth/webauthn/*`). Sets `HttpOnly; Secure; SameSite=Strict` cookie `tsid` = opaque 256-bit token; server stores `sha256(token)` in `sessions.token_hash`. 12 h idle expiry, 7 d absolute. |
| SDK / unattended | `Authorization: Bearer <api key>` → `sessions.client_kind='api_key'`; keys minted by admins (`POST /admin/api-keys`), bound to a user (API-01 desktop API is the same entitlement set; server API keys are a distinct user with `role='service'`). |
| Concurrency | On login, any existing active session of the same user from a different `device_id` is revoked with `SESSION_SUPERSEDED`; its WS is closed with code 4003 (SEC-03, ENTL-03). |
| WS auth | Cookie is sent on upgrade; the first message must be `hello`. API-key clients send `hello.token`. |
| CSRF | Cookie is SameSite=Strict + all mutating routes require header `x-requested-with: terminal`. |
| Tracing | Client may send `x-trace-id` (ULID); server echoes it and includes it in every error/`meta`. |

```ts
export const LoginRequest = z.object({ email: z.email(), password: z.string().min(8), deviceId: z.string().min(8).max(64) });
export const SessionInfo = z.object({
  userId: z.string(), firmId: z.string(), email: z.string(), displayName: z.string(), role: z.enum(['user','admin','compliance','support','service']),
  desk: z.string().nullable(), mfaEnrolled: z.boolean(), sessionId: z.string(), expiresAt: z.iso.datetime(),
  quotas: z.object({ dailyUniqueSecurities: z.object({ used: z.number(), limit: z.number() }), monthlyDataPoints: z.object({ used: z.number(), limit: z.number() }), concurrentSubscriptions: z.object({ used: z.number(), limit: z.number() }) }),
});
```

| Method | Path | Request | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | `/auth/login` | `LoginRequest` | `SessionInfo` | 401 `AUTH_INVALID_CREDENTIALS`; 423 `USER_SUSPENDED` |
| POST | `/auth/logout` | – | `{ok:true}` | revokes session |
| GET | `/auth/me` | – | `SessionInfo` | |
| POST | `/auth/webauthn/register/options` | `{}` | `PublicKeyCredentialCreationOptionsJSON` | requires session |
| POST | `/auth/webauthn/register/verify` | `RegistrationResponseJSON` | `{ok:true, credentialId}` | |
| POST | `/auth/webauthn/login/options` | `{email}` | `PublicKeyCredentialRequestOptionsJSON` | |
| POST | `/auth/webauthn/login/verify` | `{email, deviceId, response: AuthenticationResponseJSON}` | `SessionInfo` | |

---

## 2. Error envelope

```ts
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),              // stable machine code, e.g. 'SECURITY_NOT_FOUND'
    message: z.string(),           // human text shown verbatim in the panel footer
    traceId: z.string(),
    details: z.unknown().optional(),   // zod issues, entitlement reasons, etc.
    retryable: z.boolean().default(false),
  }),
});
```

| HTTP | code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | zod parse failure (`details.issues`) |
| 400 | `COMMAND_UNPARSEABLE` | `/search` or function param grammar failure |
| 401 | `AUTH_REQUIRED`, `AUTH_INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `SESSION_SUPERSEDED` | |
| 403 | `ENTITLEMENT_DENIED` (`details.reasons[]`), `LICENCE_FORBIDS_USAGE`, `TENANT_MISMATCH`, `ROLE_REQUIRED` | |
| 404 | `SECURITY_NOT_FOUND`, `FUNCTION_NOT_FOUND`, `RESULT_EXPIRED`, `NOT_FOUND` | |
| 409 | `WORKSPACE_VERSION_CONFLICT`, `DUPLICATE_NAME` | |
| 422 | `FUNCTION_NOT_APPLICABLE` (`details.assetClass`), `NOT_IN_UNIVERSE` (sector accepted, no data), `NO_SECURITY_CONTEXT` | |
| 429 | `QUOTA_EXCEEDED` (`details.kind`, `used`, `limit`, `resetAt`), `RATE_LIMITED` | |
| 503 | `PROVIDER_UNAVAILABLE` (`retryable:true`, `details.provider`), `DATA_STALE_REFUSED` | resolver needed a provider on the request path and the breaker is open |

---

## 3. Common wire types

```ts
export const AssetClass = z.enum(['equity','etf','index','fx','govt','option','future','crypto','rate','econ']);
export const MarketSector = z.enum(['Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto']);
export const LatencyTier = z.enum(['realtime','delayed','eod']);
export const StalenessTier = z.enum(['live','aging','stale','dead','closed']);
export const SessionState = z.enum(['pre','open','auction','halt','closed','post','unknown']);
export const AdjustPolicy = z.enum(['unadjusted','price','total_return']);
export const Usage = z.enum(['display','export','api','non_display']);

/** How a security is addressed anywhere in the API. Exactly one of the forms. */
export const SecurityRef = z.union([
  z.object({ key: z.string() }),                       // 'AAPL US Equity', 'SPX Index', 'T 4.25 08/15/35 Govt', 'SOFRRATE Index'
  z.object({ iid: z.string() }),                       // internal instrument id
  z.object({ figi: z.string().regex(/^BBG[0-9A-Z]{9}$/) }),
  z.object({ isin: z.string().length(12) }),
  z.object({ cusip: z.string().length(9) }),
  z.object({ occ: z.string() }),                       // 'AAPL260916C00245000'
  z.object({ formula: z.string() }),                   // CHRT-07: '<AAPL US Equity / MSFT US Equity>'
]);

export const ProvenanceRef = z.object({
  p: z.string(),                 // prov_id
  src: z.string(),               // source_id
  fetchedAt: z.iso.datetime(),
  sourceTs: z.iso.datetime().nullable(),
  key: z.string(),               // replay key
  licence: z.string(),
});

export const Timestamps = z.object({ src: z.number().nullable(), cap: z.number(), pub: z.number() });  // epoch ms (FEED-05)

export const FieldValue = z.object({
  v: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  r: z.string().optional(),      // reason code when v is null due to entitlement/unavailability
  p: z.number().optional(),      // index into meta.provenance
  ts: z.number().optional(),     // value timestamp (epoch ms) when it differs from record ts
});

export const InstrumentDto = z.object({
  iid: z.string(), key: z.string(), ticker: z.string(), sector: MarketSector, exchCode: z.string().nullable(),
  assetClass: AssetClass, name: z.string(), currency: z.string(), compositeFigi: z.string().nullable(),
  status: z.enum(['active','inactive','delisted','expired']), priceScale: z.number().int(),
  issuer: z.object({ issuerId: z.string(), name: z.string(), cik: z.number().nullable(), lei: z.string().nullable() }).nullable(),
  listings: z.array(z.object({ listingId: z.string(), figi: z.string().nullable(), mic: z.string().nullable(), bbgExchCode: z.string().nullable(), isPrimary: z.boolean(), isComposite: z.boolean() })),
  identifiers: z.record(z.string(), z.string()),   // {ISIN:'US0378331005', CUSIP:'037833100', CIK:'320193', ...}
});

export const Meta = z.object({
  traceId: z.string(),
  generatedAt: z.iso.datetime(),
  asOf: z.object({ validAt: z.iso.datetime(), knownAt: z.iso.datetime() }),
  tier: LatencyTier,
  stale: StalenessTier,
  provenance: z.array(ProvenanceRef),
  entitlement: z.array(z.object({ fieldClass: z.string(), tier: LatencyTier.or(z.literal('none')), reason: z.string().optional() })),
  quota: z.object({ dataPointsCharged: z.number() }).optional(),
});
```

---

## 4. One request model for reference / historical / intraday / tick / real-time (API-02)

`POST /data` is the single data endpoint. `type` selects the request kind; `securities`,
`fields` and `options` have the same shape for every kind. Real-time *subscriptions* use the same
`securities`/`fields` vocabulary on the WebSocket (`sub`), and `type:'realtime'` on REST returns a
one-shot snapshot from the plant.

```ts
export const DataRequestBase = z.object({
  securities: z.array(SecurityRef).min(1).max(500),
  fields: z.array(z.string()).min(1).max(100),          // field dictionary ids
  asOf: z.object({ validAt: z.iso.datetime().optional(), knownAt: z.iso.datetime().optional() }).optional(),
  usage: Usage.default('display'),
});

export const DataRequest = z.discriminatedUnion('type', [
  DataRequestBase.extend({ type: z.literal('reference') }),
  DataRequestBase.extend({ type: z.literal('historical'),
    options: z.object({
      start: z.iso.date(), end: z.iso.date().optional(),
      periodicity: z.enum(['D','W','M','Q','Y']).default('D'),
      adjust: AdjustPolicy.default('price'),
      currency: z.string().length(3).optional(),        // convert closes via fx_rates
      fill: z.enum(['none','prev']).default('none'),
      calendar: z.enum(['trading','calendar']).default('trading'),
    }) }),
  DataRequestBase.extend({ type: z.literal('intraday'),
    options: z.object({ start: z.iso.datetime(), end: z.iso.datetime().optional(), interval: z.enum(['1m','5m','15m','30m','1h']).default('1m'), session: z.enum(['regular','extended']).default('regular') }) }),
  DataRequestBase.extend({ type: z.literal('tick'),
    options: z.object({ start: z.iso.datetime(), end: z.iso.datetime(), kinds: z.array(z.enum(['quote','trade'])).default(['quote','trade']), limit: z.number().int().max(200000).default(50000) }) }),
  DataRequestBase.extend({ type: z.literal('realtime') }),   // snapshot of plant state (same fields as WS)
]);

export const SeriesPoint = z.tuple([z.number(), z.number().nullable()]);   // [epoch ms or yyyymmdd as ms, value]
export const Bar = z.object({ t: z.number(), o: z.number().nullable(), h: z.number().nullable(), l: z.number().nullable(), c: z.number(), v: z.number().nullable(), adj: z.number().optional() });

export const DataResult = z.object({
  security: SecurityRef,
  instrument: InstrumentDto.nullable(),            // null + error when unresolved
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // reference / realtime:
  fields: z.record(z.string(), FieldValue).optional(),
  // historical / intraday:
  bars: z.array(Bar).optional(),
  // tick:
  ticks: z.array(z.object({ ts: z.number(), srcTs: z.number().nullable(), kind: z.enum(['quote','trade']), bid: z.number().nullable(), ask: z.number().nullable(), bidSize: z.number().nullable(), askSize: z.number().nullable(), last: z.number().nullable(), volume: z.number().nullable(), seq: z.number().nullable() })).optional(),
  tier: LatencyTier, stale: StalenessTier, ts: Timestamps.optional(),
});
export const DataResponse = z.object({ results: z.array(DataResult), meta: Meta });
```

Convenience GETs map onto the same handler (identical output):

| GET | Equivalent |
| --- | --- |
| `/securities/{key}` | `{type:'reference', securities:[{key}], fields:['*REF*']}` (all reference fields) |
| `/securities/{key}/bars?start&end&periodicity&adjust` | `type:'historical'` |
| `/securities/{key}/intraday?start&end&interval` | `type:'intraday'` |
| `/securities/{key}/ticks?start&end` | `type:'tick'` |
| `/securities/{key}/quote` | `type:'realtime'` with all `quote`/`trade`/`ohlc` fields |

Quota charging (API-06): every `DataResult` charges `securities × fields` (reference/realtime) or
`securities × bars` (historical/intraday) or `ticks.length` (tick) data points; unique
instrument ids are added to the daily set. Limits are per user (or firm default) in
`quota_limits`; exceeding returns 429 `QUOTA_EXCEEDED` **before** any data is fetched.

---

## 5. Search and universe

```ts
export const SearchRequest = z.object({ q: z.string().min(1).max(80), limit: z.number().int().min(1).max(25).default(12),
  kinds: z.array(z.enum(['instrument','function','person','topic'])).optional(),
  context: z.object({ securityKey: z.string().optional(), functionCode: z.string().optional() }).optional() });
export const SearchHit = z.object({
  kind: z.enum(['instrument','function','person','topic']),
  id: z.string(),                          // iid | function code | user id | topic code
  primary: z.string(),                     // 'AAPL US Equity' | 'GP' | 'Jane Doe (Demo Desk)' | 'MARKETS'
  secondary: z.string(),                   // 'APPLE INC · Common Stock · NASDAQ' | 'Price Graph'
  assetClass: AssetClass.optional(),
  score: z.number(),
  matched: z.array(z.tuple([z.number(), z.number()])),   // highlight ranges in `primary`
  source: z.enum(['local','yahoo']).default('local'),
});
export const SearchResponse = z.object({ hits: z.array(SearchHit), meta: Meta.pick({ traceId: true }) });
```

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/search?q=&limit=&kinds=` | Server-side ranking with the same `@terminal/core` ranker; falls back to Yahoo `v1/finance/search` (max 8 hits, `source:'yahoo'`, never auto-added to master) when local hits < 3 and `q.length ≥ 2`. p95 < 80 ms local. |
| GET | `/universe/snapshot` | ETag'd, gzip; body `UniverseSnapshot` (below). ≈ 1.2 MB gz for 38k instruments. Client caches in IndexedDB and revalidates hourly. |

```ts
export const UniverseSnapshot = z.object({
  version: z.string(),                     // sha1 of content
  generatedAt: z.iso.datetime(),
  instruments: z.array(z.tuple([
    z.string(),   // iid
    z.string(),   // ticker
    MarketSector,
    z.string(),   // exchCode ('' when none)
    z.string(),   // name
    AssetClass,
    z.number(),   // popularity 0..100 (index membership, symbol-book presence, recent views)
    z.number(),   // status: 1 active, 0 inactive
  ])),
  functions: z.array(z.tuple([z.string(), z.string(), z.array(z.string()), z.number()])),  // code, name, aliases, tier
  people: z.array(z.tuple([z.string(), z.string(), z.string()])),                            // userId, displayName, firm
  topics: z.array(z.tuple([z.string(), z.string()])),                                        // code, name
});
```

---

## 6. Functions

```ts
export const FunctionRunRequest = z.object({
  security: SecurityRef.optional(),            // required when manifest.requiresSecurity
  params: z.record(z.string(), z.unknown()).default({}),   // validated against manifest.params
  panel: z.number().int().min(0).max(7).optional(),
  asOf: Meta.shape.asOf.partial().optional(),
});
export const FunctionRunResponse = z.object({
  resultId: z.string(),                        // ULID; export & share use it (10-min TTL)
  code: z.string(), variant: AssetClass.or(z.literal('none')),
  instrument: InstrumentDto.nullable(),
  params: z.record(z.string(), z.unknown()),   // normalised params (defaults applied)
  payload: z.unknown(),                        // manifest-specific (FUNCTIONS.md)
  live: z.object({ subjects: z.array(z.string()), fields: z.array(z.string()) }).nullable(),
  page: z.object({ index: z.number(), count: z.number(), cursor: z.string().nullable() }).optional(),
  meta: Meta,
});
```

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/functions` | Registry (manifests without resolvers): code, name, aliases, tier, assetClasses, param JSON-schema (from zod), csv columns, help. Cached by ETag. |
| POST | `/functions/{code}/run` | Runs the function (§ ARCHITECTURE 4). Emits `usage_events` `function.launch` (or `function.param` if `x-usage-kind: param`). |
| POST | `/functions/{code}/page` | `{resultId, direction:'fwd'|'back'}` → next page of a pageable function (TOP, N, EQS, SRCH, HP). |
| GET | `/results/{resultId}/export.csv` | CSV from the cached payload via `core/functions/csv.ts`; re-checks entitlement with `usage='export'`; 403 `LICENCE_FORBIDS_USAGE` never partial. Emits `function.export`. `Content-Disposition: attachment; filename="DES_AAPL_US_Equity_20260915T1441Z.csv"` |
| GET | `/results/{resultId}` | Returns the cached `FunctionRunResponse` (used by MSG-04 share links, within entitlements of the *viewer*: the server re-runs with the viewer's entitlements if the cached result was produced for another user). |

---

## 7. Field dictionary (API-07)

`GET /fields` → `FieldDictionary`; also shipped as `packages/sdk/src/fields.json` generated from
`core/fields/dictionary.ts` (`npm run gen:fields`). Versioned by `schema_meta.field_dictionary_version`
(`2026.09.0`); deprecations carry `deprecatedSince` and `replacement` and stay resolvable for two
minor versions.

```ts
export const FieldDef = z.object({
  id: z.string(),                          // 'PX_LAST'
  label: z.string(),                       // 'Last Price'
  description: z.string(),
  type: z.enum(['number','integer','string','boolean','date','datetime','enum']),
  unit: z.string().nullable(),             // 'ccy' | 'pct' | 'bp' | 'shares' | 'contracts' | 'years' | null
  decimals: z.number().int().nullable(),   // null = instrument priceScale
  fieldClass: z.enum(['quote','trade','ohlc','reference','fundamental','econ','rates','curve','derived','news','holdings','options','fx','crypto']),
  sourceId: z.string(),                    // primary source
  updateFrequency: z.enum(['tick','1m','daily','weekly','monthly','quarterly','on_filing','static']),
  applicableAssetClasses: z.array(AssetClass),
  example: z.object({ security: z.string(), value: z.unknown(), asOf: z.string() }),
  deprecatedSince: z.string().optional(), replacement: z.string().optional(),
});
export const FieldDictionary = z.object({ version: z.string(), fields: z.array(FieldDef) });
```

Core quote/trade/ohlc ids (all sources map into these): `PX_LAST`, `PX_BID`, `PX_ASK`, `BID_SIZE`,
`ASK_SIZE`, `PX_OPEN`, `PX_HIGH`, `PX_LOW`, `PX_PREV_CLOSE`, `PX_VOLUME`, `CHG_NET_1D`,
`CHG_PCT_1D`, `TICK_DIR`, `LAST_TRADE_TS`, `SRC_SEQ`, `IVOL_30D`, `IVOL_30D_CHG`, `SESSION_STATE`,
`STALE_TIER`, `PX_VWAP_1D`. Reference: `NAME`, `TICKER`, `COMPOSITE_FIGI`, `ISIN`, `CUSIP`,
`SEDOL`, `CIK`, `LEI`, `SECURITY_TYPE`, `MARKET_SECTOR`, `EXCH_CODE`, `MIC`, `CRNCY`,
`GICS_SECTOR`, `GICS_SUB_INDUSTRY`, `SIC`, `COUNTRY`, `FISCAL_YEAR_END`, `SHARES_OUT`,
`PUBLIC_FLOAT`, `IDX_MEMBER_SPX`. Govt: `CPN`, `MATURITY`, `ISSUE_DT`, `DAY_CNT`, `CPN_FREQ`,
`SEC_TYPE`, `BENCHMARK_TENOR`. Options: `OPT_STRIKE`, `OPT_EXPIRY`, `OPT_PUT_CALL`, `OPT_MULT`,
`OPT_IV`, `OPT_DELTA`, `OPT_GAMMA`, `OPT_VEGA`, `OPT_THETA`, `OPT_RHO`, `OPT_THEO`, `OPT_OI`.
Fundamentals: `SALES_REV_TURN`, `GROSS_PROFIT`, `EBIT`, `NET_INCOME`, `EPS_DILUTED`,
`TOT_ASSETS`, `TOT_LIAB`, `TOT_EQY`, `CF_FREE_CASH_FLOW`, `PE_RATIO`, `PX_TO_BOOK`, `EV_TO_EBITDA`,
`ROE`, `NET_DEBT`. Econ/rates: `ECO_VALUE`, `ECO_PRIOR`, `ECO_REVISED`, `RATE_VALUE`,
`RATE_PCT_1`, `RATE_PCT_25`, `RATE_PCT_75`, `RATE_PCT_99`, `RATE_VOLUME_BN`, `FED_TARGET_LO`,
`FED_TARGET_HI`. Curves: `CURVE_PAR`, `CURVE_ZERO`, `CURVE_DF`, `CURVE_FWD_3M`.

---

## 8. Workspaces, watchlists, portfolios, messaging, alerts, help

```ts
export const PanelFrame = z.object({ securityKey: z.string().nullable(), code: z.string().nullable(), params: z.record(z.string(), z.unknown()), scroll: z.number().default(0) });
export const PanelState = z.object({ id: z.number().int(), frames: z.array(PanelFrame).max(50), index: z.number().int(), commandDraft: z.string().default('') });
export const WorkspaceLayout = z.object({
  version: z.literal(2),
  mode: z.enum(['1','2h','2v','4']),
  panels: z.array(PanelState).min(1).max(8),
  focusedPanel: z.number().int(),
  monitors: z.array(z.object({ id: z.string(), title: z.string(), watchlistId: z.string().nullable(), columns: z.array(z.string()), sort: z.object({ col: z.string(), dir: z.enum(['asc','desc']) }).nullable(), groupBy: z.string().nullable() })),
  chart: z.object({ defaultRange: z.string(), defaultType: z.string(), studies: z.array(z.string()) }),
  conflateMs: z.number().int().min(50).max(2000).default(250),
  windows: z.array(z.object({ windowId: z.string(), screen: z.string(), bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]), panelIds: z.array(z.number()) })).default([]),  // TERM-10 multi-window
});
```

| Method | Path | Request → Response | Notes |
| --- | --- | --- | --- |
| GET | `/workspaces` | → `{workspaces: [{id,name,isDefault,version,updatedAt}]}` | |
| GET | `/workspaces/{id}` | → `{id, name, version, layout: WorkspaceLayout}` | |
| PUT | `/workspaces/{id}` | `{version, layout}` → same | 409 on version mismatch (client merges and retries); autosave debounced 2 s |
| POST | `/workspaces` | `{name, layout}` → | |
| GET/POST/PUT/DELETE | `/watchlists`, `/watchlists/{id}`, `/watchlists/{id}/items` | `{name, columns, items:[{key|formula,label}]}` | shared via `sharedWith` |
| GET/POST | `/portfolios`, `/portfolios/{id}/positions` | upload: `multipart/form-data` CSV (`identifier,quantity,cost_basis,currency`) → `{uploadId, rowsOk, rowsError, errors[]}` (PORT-01 reconciliation report) | |
| GET | `/portfolios/{id}/analytics?asOf=` | → PORT payload (FUNCTIONS.md PORT) | same code path as function PORT |
| GET | `/rooms`, `/rooms/{id}/messages?before=&limit=` | → `{messages:[{id, seq, sender, sentAt, body, attachments, hash}]}` | RLS enforced |
| POST | `/rooms`, `/rooms/{id}/messages` | `{body, attachments?}` → message | policy checks (permitted counterparties, ethical walls) → 403 `POLICY_BLOCKED` |
| GET/POST/PUT/DELETE | `/alerts`, `/alerts/{id}` | | delivered on WS `alerts:<uid>` |
| POST | `/help/tickets` | `{functionCode, securityKey, params, traceId, question}` → `{ticketId}` | HELP ×2 |
| GET | `/help/{code}` | → `{code, name, summary, keys:[{key, action}], params:[...], sources:[...]}` | HELP ×1 content, generated from manifest |
| GET | `/entitlements/me` | → `[{sourceId, fieldClass, tier, usage}]` | |
| GET | `/usage/declarations?month=YYYY-MM` | → `[{sourceId, fieldClass, tier, users, accesses}]` | role admin/compliance (ENTL-06) |
| GET | `/usage/functions?days=30` | → `[{code, launches, users}]` | FUNC-04 |
| GET | `/status` | → metrics JSON (ARCHITECTURE §10) | |
| GET | `/health` | → `{ok, db, plant, scheduler}` | |

---

## 9. WebSocket protocol (`/ws/v1`) — BUS-01..08, ENTL-05

Text frames, one JSON object per frame. Server→client deltas are batched into one `batch` frame
per conflation flush. All messages carry an optional `t` (trace id).

### 9.1 Client → server

```ts
export const ClientMessage = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hello'), protocol: z.literal(1), client: z.string(), token: z.string().optional(), conflateMs: z.number().int().min(50).max(2000).default(250), resumeSessionId: z.string().optional() }),
  z.object({ op: z.literal('sub'), id: z.string(),                         // client subscription id
    subjects: z.array(z.string()).min(1).max(2000),                        // 'q:123', 'chain:123', 'bar1m:123', 'news:MARKETS', 'rate:SOFR', 'alerts:me', 'room:45'
    fields: z.array(z.string()).min(1).max(64).or(z.literal('*')),
    lastSeq: z.record(z.string(), z.number()).optional(),                  // resync: subject → last applied seq
    usage: z.literal('display').default('display') }),
  z.object({ op: z.literal('unsub'), id: z.string(), subjects: z.array(z.string()).optional() }),
  z.object({ op: z.literal('conflate'), ms: z.number().int().min(50).max(2000) }),
  z.object({ op: z.literal('ping'), t: z.number() }),
]);
```

### 9.2 Server → client

```ts
export const Delta = z.object({ op: z.literal('delta'), s: z.string(), seq: z.number(), skipped: z.number().default(0),
  f: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])), ts: Timestamps, id: z.array(z.string()).optional() });
export const Snapshot = z.object({ op: z.literal('snap'), s: z.string(), seq: z.number(), tier: LatencyTier, stale: StalenessTier, session: SessionState,
  f: z.record(z.string(), FieldValue), ts: Timestamps, prov: ProvenanceRef, id: z.array(z.string()) });
export const ServerMessage = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hello'), sessionId: z.string(), serverTime: z.number(), conflateMs: z.number(), limits: z.object({ maxSubjects: z.number(), maxFields: z.number() }) }),
  Snapshot,
  z.object({ op: z.literal('batch'), msgs: z.array(z.union([Delta, Snapshot])) }),
  z.object({ op: z.literal('stale'), s: z.string(), stale: StalenessTier, sinceCap: z.number() }),
  z.object({ op: z.literal('downgrade'), s: z.string(), id: z.string(), requested: LatencyTier, granted: LatencyTier.or(z.literal('none')), reason: z.string(), fields: z.array(z.string()).optional() }),
  z.object({ op: z.literal('reject'), id: z.string(), s: z.string().optional(), code: z.string(), message: z.string() }),
  z.object({ op: z.literal('slow'), level: z.number().int().min(0).max(4), conflateMs: z.number(), buffered: z.number(), action: z.enum(['widen','snapshot_only','shed','close']) }),
  z.object({ op: z.literal('resync'), s: z.array(z.string()), reason: z.string() }),        // followed by snapshots
  z.object({ op: z.literal('shed'), s: z.array(z.string()), reason: z.string() }),          // NFR-02: non-essential subscriptions dropped (client must re-sub later)
  z.object({ op: z.literal('alert'), alertId: z.string(), firedAt: z.number(), payload: z.unknown() }),
  z.object({ op: z.literal('msg'), room: z.string(), message: z.unknown() }),
  z.object({ op: z.literal('news'), topic: z.string(), item: z.unknown() }),
  z.object({ op: z.literal('pong'), t: z.number(), serverTime: z.number() }),
  z.object({ op: z.literal('bye'), code: z.number(), reason: z.string() }),
]);
```

### 9.3 Sequencing, conflation and recovery guarantees

| Guarantee | Mechanism |
| --- | --- |
| Per-subject monotonic `seq` | Plant increments `seq` per applied update; snapshot carries the seq at capture. |
| Latest value never dropped (BUS-03) | Conflator keeps one merged delta per subject per session; `f` holds the last value of each field changed since the previous flush; `seq` = last applied; `skipped` = number of intermediate deltas merged. |
| Client gap detection | Client accepts a delta if `seq === prev + 1 + skipped`; otherwise emits `sub` with `lastSeq` for that subject; server replies with a fresh `snap` (never a partial replay). |
| Reconnect (BUS-07) | `WsClient` reconnects with backoff (0.5 s → 8 s), sends `hello{resumeSessionId}` then re-issues `sub` for every live subscription with `lastSeq`; server always answers with `snap` for each subject (idempotent; deltas applied after the snapshot are guaranteed ≥ snapshot seq). Duplicates are impossible because a snapshot resets the client state. |
| Field-set granularity (BUS-02) | Each subscription has its own field filter; a session subscribed to `PX_LAST` for `q:1` never receives `PX_BID`. Multiple subscriptions to one subject with different fields are merged per session (union) and re-filtered per subscription id on send (`id[]` lists the subscription ids a message satisfies). |
| Entitlement (ENTL-05) | Evaluated at `sub` per subject × field class × requested tier; result `downgrade` with reason; blank fields are delivered as `{v:null, r:'<reason>'}` in the snapshot and never in deltas. Re-evaluated when entitlements change (cache version bump) — the server sends `downgrade`/`resync` as needed. |
| Slow consumer (BUS-04) | Levels 0–4 by `ws.bufferedAmount`: > 256 KiB → level 1 (conflate ×2), > 1 MiB → 2 (×4), > 4 MiB → 3 (snapshot-only every 2 s, `shed` of non-essential subjects: `news:*`, `chain:*`), > 8 MiB or level 3 for 30 s → close 4008 `SLOW_CONSUMER`. Every transition is announced with `slow`. |
| Overload (NFR-02) | Global plant pressure (publish queue > 50k) widens every session's conflation to ≥ 500 ms and sheds `chain:*` first, then `bar1m:*`; `PX_LAST` deltas are never shed. |
| Limits (BUS-08 scaled to v1) | 10,000 subjects per session (`limits.maxSubjects`), 64 fields per subscription; the plant holds all subscriptions in `Map<subject, Set<session>>` — 10 M entries is memory-bound only. |
| Heartbeat | Client pings every 15 s; server closes after 45 s silence (4000 `IDLE`). |

### 9.4 Reason codes

| Code | Where | Meaning |
| --- | --- | --- |
| `TIER_UNAVAILABLE_SOURCE_DELAYED` | downgrade | Source is delayed-only; realtime request served as delayed. |
| `TIER_EOD_ONLY` | downgrade | Source only publishes EOD. |
| `NO_FIRM_ENTITLEMENT` | downgrade/blank | Firm has no entitlement for source × field class. |
| `NO_USER_ENTITLEMENT` | downgrade/blank | User not granted within firm contract. |
| `LICENCE_FORBIDS_USAGE` | reject/403 | Registry forbids this usage (e.g. export). |
| `INSTRUMENT_SCOPE` | downgrade | Entitlement scoped to another instrument set. |
| `SUBJECT_UNKNOWN` | reject | Subject grammar/instrument not found. |
| `FIELD_UNKNOWN` | reject | Field id not in dictionary. |
| `QUOTA_CONCURRENT_SUBSCRIPTIONS` | reject | API-06. |
| `SLOW_CONSUMER` | slow/bye | Backpressure escalation. |
| `PLANT_OVERLOAD` | shed | NFR-02 shedding. |
| `SESSION_SUPERSEDED` | bye 4003 | Another login for this user. |
| `NOT_IN_UNIVERSE` | reject | Sector parsed but no data (e.g. `Corp`). |
| `STALE_SOURCE` | stale | Source stopped updating during session. |

### 9.5 Subject grammar

`q:<iid>` composite quote · `chain:<iid>` option chain summary (per-expiry aggregates + per-contract
deltas, fields prefixed `OPT_`) · `bar1m:<iid>` streaming 1-minute bars (`f` = `{t,o,h,l,c,v}` of the
forming bar) · `news:<TOPIC>` · `news:i:<iid>` instrument news · `rate:<CODE>` · `idx:<CODE>` (alias for
`q:` of the index instrument) · `alerts:me` · `room:<roomId>` · `sys:status`.

### 9.6 Close codes

`1000` normal · `1001` server shutdown (client reconnects) · `4000 IDLE` · `4001 AUTH_REQUIRED` ·
`4002 PROTOCOL_ERROR` · `4003 SESSION_SUPERSEDED` · `4008 SLOW_CONSUMER` · `4029 RATE_LIMITED`.

---

## 10. Export endpoints (FUNC-03)

| Endpoint | Output |
| --- | --- |
| `GET /results/{resultId}/export.csv` | Function payload as CSV (columns per manifest `csv`); first line `# source: <attribution list>; generated: <iso>; trace: <id>; asOf: <validAt>/<knownAt>`; numbers unformatted (full precision), dates ISO. |
| `POST /data` with header `Accept: text/csv` | `DataResponse` flattened: reference → one row per security; historical/intraday → one row per bar (`security,t,o,h,l,c,v`); tick → one row per tick. Same entitlement check with `usage:'export'`. |
| `GET /watchlists/{id}/export.csv` | Watchlist grid with the same field values the W screen shows (resolved via `type:'realtime'`). |

Excel is a non-goal (BRIEF): CSV opens in Excel; the JS SDK is the programmatic path.

---

## 11. Rate limits and quotas

| Scope | Limit | Error |
| --- | --- | --- |
| REST per session | 30 req/s burst 60 | 429 `RATE_LIMITED` (`Retry-After`) |
| `/search` | 20 req/s | same |
| `/data` payload | ≤ 500 securities × 100 fields; historical ≤ 10 years daily per security | 400 `VALIDATION_FAILED` |
| Daily unique securities | default 5,000 per user | 429 `QUOTA_EXCEEDED` |
| Monthly data points | default 20 M per user | 429 |
| Concurrent subscriptions | default 10,000 subjects per session, 20,000 per user | WS `reject QUOTA_CONCURRENT_SUBSCRIPTIONS` |
| Export | 60 per hour per user | 429 |

---

## 12. Versioning and compatibility (OPS-02)

Path version `v1`; additive changes only within v1 (new fields, new ops); breaking changes go to
`v2` with both served for ≥ 2 client versions. WS `hello.protocol` is negotiated: server supports
`[1]` now; unknown protocol → `bye 4002`. The client sends `client: 'web/1.4.0'`; the server may
respond with `hello.minClient` to force a soft reload after deploy (never disconnects live sessions
first).
