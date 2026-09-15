# API — candidate C

All wire types are zod schemas in `packages/sdk/src/wire/{rest,ws,errors}.ts` and are the *only* definition of
the protocol; the server validates every inbound body/query/param and every outbound payload with them
(`fastify-type-provider-zod`, response validation on in test/dev, sampled 1 % in prod), and the SDK parses
every response with the same schemas. The web client uses the SDK exclusively (API-05).

Base path `/api/v1`. JSON everywhere except `text/csv` exports. Protocol version header
`x-terminal-protocol: 1`; the server supports the current and previous version (OPS-02).

## 1. Auth and session model

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `/auth/login` | POST | `{ email, password, deviceId, deviceLabel? }` | `{ session: SessionInfo, requiresWebAuthn: boolean, takeover?: { otherSessions: SessionSummary[] } }` |
| `/auth/webauthn/register/options` | POST | `{}` | WebAuthn `PublicKeyCredentialCreationOptions` (JSON) |
| `/auth/webauthn/register/verify` | POST | attestation response | `{ credentialId }` |
| `/auth/webauthn/login/options` | POST | `{ email }` | `PublicKeyCredentialRequestOptions` |
| `/auth/webauthn/login/verify` | POST | assertion response + `deviceId` | `{ session: SessionInfo }` |
| `/auth/takeover` | POST | `{ revokeSessionIds: uuid[] }` | `{ session: SessionInfo }` (lifts `restricted`) |
| `/auth/logout` | POST | — | `204` |
| `/auth/session` | GET | — | `SessionInfo` |
| `/auth/api-keys` | GET/POST/DELETE | `{ label, scopes }` | `{ id, label, scopes, createdAt, secret? }` (secret only on create) |

```ts
export const SessionInfo = z.object({
  sessionId: z.string().uuid(), userId: z.string().uuid(), firmId: z.string().uuid(),
  email: z.string(), displayName: z.string(), role: z.enum(['user','admin','compliance','dataops']),
  restricted: z.boolean(),                       // concurrent-session restriction in force (ENTL-03/SEC-03)
  restrictedReason: z.enum(['CONCURRENT_SESSION']).optional(),
  entitlements: z.array(z.object({ assetClass: AssetClass.nullable(), fieldClass: z.string().nullable(),
                                   tier: Tier, usageTypes: z.array(UsageType) })),
  quotas: z.object({ dailyUniqueSecurities: z.number(), monthlyDatapoints: z.number(), concurrentSubscriptions: z.number() }),
  expiresAt: z.string().datetime(), protocol: z.literal(1)
});
```

* Web: opaque 256-bit token in an `httpOnly; Secure; SameSite=Strict` cookie `tsid`; API: `Authorization:
  Bearer <api key>` (bound to the natural person who created it; API-01 "desktop API bound to the logged-in
  user"). Server-side unattended keys are the same object with scope `server` and are priced separately
  (out of scope for enforcement beyond the scope flag).
* One person, many devices: a login from a second `deviceId` while another web session is active marks the new
  session `restricted` (eod only, reason `CONCURRENT_SESSION`) and returns `takeover.otherSessions`; the user
  may take over (revokes the others, `revoked_reason='takeover'`). API sessions never restrict web sessions but
  count against `concurrentSubscriptions`.
* Session TTL 12 h sliding (`last_seen_at`), absolute 7 days. Every request sets `SET LOCAL app.user_id/app.firm_id/app.role`.
* MFA: password + WebAuthn when the user has a credential registered (`requiresWebAuthn`), enforced for `admin`
  and `compliance` roles (SEC-02).

## 2. Error envelope

```ts
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.enum(['BAD_REQUEST','VALIDATION','UNAUTHENTICATED','FORBIDDEN','NOT_ENTITLED','QUOTA_EXCEEDED',
                  'NOT_FOUND','AMBIGUOUS','CONFLICT','RATE_LIMITED','PROVIDER_UNAVAILABLE','REPLAY_MISS',
                  'INTERNAL','PROTOCOL_VERSION']),
    message: z.string(),
    traceId: z.string(),
    details: z.unknown().optional(),            // zod issues, DowngradeReason, quota numbers, candidates for AMBIGUOUS
    retryAfterMs: z.number().optional()
  })
});
```
HTTP mapping: 400 BAD_REQUEST/VALIDATION, 401 UNAUTHENTICATED, 403 FORBIDDEN/NOT_ENTITLED, 404 NOT_FOUND,
409 CONFLICT/AMBIGUOUS, 429 QUOTA_EXCEEDED/RATE_LIMITED, 502 PROVIDER_UNAVAILABLE, 500 INTERNAL/REPLAY_MISS,
426 PROTOCOL_VERSION. Every response carries `x-trace-id`.

## 3. Common types

```ts
export const AssetClass = z.enum(['equity','etf','index','fx','govt','option','future','crypto','rate','econ']);
export const Tier = z.enum(['eod','delayed','realtime']);
export const UsageType = z.enum(['display','export','api']);
export const ValueState = z.enum(['live','delayed','stale','closed','blank','na']);
export const DowngradeReason = z.enum(['OK','NOT_ENTITLED_TIER','SOURCE_TIER_CAP','LICENCE_NO_EXPORT','LICENCE_NO_API',
  'QUOTA_EXCEEDED','CONCURRENT_SESSION','BLANK_NOT_ENTITLED','TIER_EOD','PROVIDER_DOWN','NO_SOURCE']);
export const MarketSector = z.enum(['Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto']);

export const SecurityRef = z.union([                       // accepted everywhere a security is named
  z.object({ id: z.string().regex(/^[A-Z0-9]{12}$/) }),   // internal id (FIGI or TRM…)
  z.object({ figi: z.string().length(12) }),
  z.object({ isin: z.string().length(12) }),
  z.object({ cusip: z.string().length(9) }),
  z.object({ occ: z.string().min(16).max(21) }),
  z.object({ ticker: z.string(), sector: MarketSector.default('Equity'), exchCode: z.string().optional() }),
  z.object({ series: z.string() }),                       // econ series id 'FRED:CPIAUCSL'
  z.object({ formula: z.string() })                       // CHRT-07 computed series, e.g. "AAPL US Equity / MSFT US Equity"
]);
export const ResolvedRef = z.object({
  id: z.string(), assetClass: AssetClass, sector: MarketSector, ticker: z.string(), name: z.string(),
  currency: z.string(), exchCode: z.string().nullable(), figi: z.string().nullable(), display: z.string() // 'AAPL US Equity'
});
export const AsOf = z.object({ validAt: z.string().datetime().optional(), knownAt: z.string().datetime().optional() });
export const ProvRef = z.object({ provider: z.string(), provId: z.number().int(), srcSeq: z.number().optional(), capturedAt: z.string().datetime() });
export const FieldValue = z.object({
  v: z.union([z.number(), z.string(), z.null()]),
  ts: z.string().datetime().nullable(),          // src ts of the value
  st: ValueState, tier: Tier, prov: z.number().int().nullable(), reason: DowngradeReason.optional()
});
```

## 4. One request model for reference / historical / intraday / tick / real-time (API-02)

`POST /data` accepts a discriminated union; every variant names `securities: SecurityRef[]` and `fields`
from the same dictionary, and returns the same `DataResponse`. The WS `sub` message (§7) is the sixth variant
of the same shape. GET conveniences (`/history`, `/intraday`, `/ticks`, `/snapshot`, `/ref`) are thin
adapters that build the same `DataRequest`.

```ts
export const DataRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reference'), securities: z.array(SecurityRef).max(500), fields: z.array(FieldId).max(200), asOf: AsOf.optional() }),
  z.object({ type: z.literal('historical'), securities: z.array(SecurityRef).max(50), fields: z.array(FieldId).default(['PX_OPEN','PX_HIGH','PX_LOW','PX_LAST','VOLUME']),
             start: z.string().date(), end: z.string().date(), periodicity: z.enum(['D','W','M','Q','Y']).default('D'),
             adjust: z.enum(['none','split','split_div','total_return']).default('split'), currency: z.string().length(3).optional(),
             fill: z.enum(['none','prev']).default('none'), asOf: AsOf.optional() }),
  z.object({ type: z.literal('intraday'), securities: z.array(SecurityRef).max(20), interval: z.enum(['1m','5m','15m','1h']).default('1m'),
             start: z.string().datetime(), end: z.string().datetime(), session: z.enum(['regular','all']).default('regular') }),
  z.object({ type: z.literal('tick'), securities: z.array(SecurityRef).max(5), start: z.string().datetime(), end: z.string().datetime(),
             kinds: z.array(z.enum(['trade','quote'])).default(['trade','quote']), limit: z.number().int().max(50000).default(10000) }),
  z.object({ type: z.literal('snapshot'), securities: z.array(SecurityRef).max(500), fields: z.array(FieldId).max(100), tier: Tier.optional() }),
  z.object({ type: z.literal('subscribe'), securities: z.array(SecurityRef).max(10000), fields: z.array(FieldId).max(100), tier: Tier.optional() }) // WS only
]);

export const SeriesBlock = z.object({
  columns: z.array(FieldId), index: z.array(z.string()),          // ISO dates or datetimes
  rows: z.array(z.array(z.union([z.number(), z.string(), z.null()]))),
  adjust: z.string().optional(), prov: z.array(z.number().int())
});
export const SecurityResult = z.object({
  security: ResolvedRef, tier: Tier, reason: DowngradeReason,
  fields: z.record(FieldId, FieldValue).optional(),              // reference / snapshot
  series: SeriesBlock.optional(),                                // historical / intraday
  ticks: z.array(z.object({ ts: z.string(), kind: z.string(), price: z.number().nullable(), size: z.number().nullable(),
                            bid: z.number().nullable(), ask: z.number().nullable(), bidSize: z.number().nullable(), askSize: z.number().nullable(),
                            srcTs: z.string().nullable(), capTs: z.string(), pubTs: z.string(), prov: z.number() })).optional(),
  provenance: z.array(ProvRef)
});
export const DataResponse = z.object({
  request: DataRequest, asOf: z.object({ valuationTs: z.string().datetime(), knownAt: z.string().datetime() }),
  results: z.array(SecurityResult),
  errors: z.array(z.object({ security: SecurityRef, code: z.string(), message: z.string(), candidates: z.array(ResolvedRef).optional() })),
  traceId: z.string()
});
```

Routes:

| Route | Method | Notes |
| --- | --- | --- |
| `/data` | POST | body `DataRequest` (not `subscribe`) → `DataResponse` |
| `/ref/resolve` | GET `?q=AAPL&sector=Equity&exchCode=US` or POST `{refs: SecurityRef[]}` | `{ resolved: ResolvedRef[], ambiguous: {...}[] }`; misses go to OpenFIGI mapping then Yahoo search, and create master rows |
| `/ref/:id` | GET | `type:'reference'` with all reference fields; `?validAt&knownAt` |
| `/ref/:id/history` | GET | bitemporal versions of the instrument row + xref (REF-03 answerability) |
| `/history` | GET `?security=AAPL US Equity&start&end&periodicity&adjust&fields` | `type:'historical'` |
| `/intraday` | GET | `type:'intraday'` |
| `/ticks` | GET | `type:'tick'` |
| `/snapshot` | GET `?securities=…&fields=…` | `type:'snapshot'` (served from the plant; cold subjects trigger a fetch and return `st:'blank'` with `reason:'PROVIDER_DOWN'` only on failure) |
| `/search` | GET `?q=&limit=8&panelSecurity=` | `{ hits: SearchHit[] }` (FUNCTIONS.md §3 ranking; server side of autocomplete) |
| `/fields` | GET `?class=&version=` | field dictionary (§6) |
| `/fields/:id` | GET | one `FieldDef` with examples |
| `/calendar/:calendarId` | GET `?from&to` | holidays + early closes |
| `/corporate-actions` | GET `?security&from&to&status` | current versions as of `knownAt` |
| `/curves/:curveId` | GET `?asOf&build=true` | points + optional `curve_build` output |
| `/rates/:rateId` | GET `?from&to` | fixings (latest vintage unless `vintages=true`) |
| `/econ/series/:id` | GET `?from&to&vintage=latest|all` | observations |
| `/econ/calendar` | GET `?from&to&country` | release events |
| `/news` | GET `?q&security&topic&feed&from&to&limit&cursor` | full-text (`websearch_to_tsquery`) + entity filters, newest first |
| `/news/:id` | GET | item + links |
| `/options/chain` | GET `?underlying=&expiry=` | latest chain snapshot + terms |
| `/index/:indexId/members` | GET `?validAt&knownAt` | membership with weights |
| `/holders` | GET `?security` | ETF/13F holders |
| `/status` | GET | provider health, plant state, market sessions (OPS-04) |

## 5. Functions

| Route | Method | Notes |
| --- | --- | --- |
| `/fn` | GET | `FunctionManifestPublic[]` (code, aliases, tier, assetClasses, params JSON schema, help, csv columns, payloadVersion) |
| `/fn/:code` | POST `{ security?: SecurityRef, params?: object, asOf?: AsOf, panel?: number }` | `Payload<T>` (§5.1) |
| `/fn/:code/csv` | POST same body (or GET with query) | `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<CODE>_<display>_<asOf>.csv"`; entitlement evaluated with `usage:'export'`; emits `fn.export` |
| `/fn/:code/help` | GET | help text, keys, field definitions used by the screen |

```ts
export const Payload = <T extends z.ZodTypeAny>(data: T) => z.object({
  fn: z.string(), version: z.number().int(),
  security: ResolvedRef.nullable(), params: z.record(z.unknown()),
  asOf: z.object({ valuationTs: z.string().datetime(), knownAt: z.string().datetime() }),
  data,
  provenance: z.array(ProvRef),
  staleness: z.object({ worst: ValueState, byField: z.record(ValueState).optional() }),
  entitlement: z.object({ tier: Tier, downgrades: z.array(z.object({ scope: z.string(), reason: DowngradeReason })) }),
  engines: z.array(z.object({ name: z.string(), version: z.string() })).default([]),
  subjects: z.array(z.object({ subject: z.string(), fields: z.array(FieldId), essential: z.boolean() })),  // live subscriptions the screen should open
  traceId: z.string()
});
```

Reproducibility contract: `POST /fn/:code` with an explicit `asOf` and identical `params` returns
byte-identical `data` and `engines` regardless of wall-clock time; only `traceId`, `provenance[].capturedAt`
for live subjects and `staleness` may differ.

## 6. Field dictionary format (API-07)

`GET /fields` returns `{ version: '2026.09.1', fields: FieldDef[] }`. The dictionary is defined in
`packages/core/src/fields/dictionary.ts` and is the same object the SDK exports and the client formats with.

```ts
export const FieldDef = z.object({
  id: z.string().regex(/^[A-Z0-9_]{2,40}$/),         // 'PX_LAST'
  name: z.string(), definition: z.string(),
  class: z.enum(['price','book','reference','fundamentals','news','econ','derived','holdings','curve','rate']),
  type: z.enum(['number','integer','string','date','datetime','enum','boolean']),
  unit: z.string().nullable(),                         // 'USD','%','bp','shares','x','days'
  scale: z.number().int().nullable(),                  // display decimals hint; formatter honours priceHint per instrument for prices
  assetClasses: z.array(AssetClass),                   // where it is meaningful
  sources: z.array(z.object({ provider: z.string(), path: z.string(), licence: z.string() })),  // e.g. cboe.quotes → data.current_price
  updateFrequency: z.enum(['tick','15s','1m','daily','weekly','monthly','quarterly','static']),
  since: z.string(), deprecated: z.object({ since: z.string(), replacedBy: z.string().nullable(), removeAfter: z.string() }).nullable(),
  examples: z.array(z.object({ security: z.string(), value: z.union([z.number(), z.string()]), asOf: z.string() }))
});
```

Deprecation policy (API-03): a field is marked `deprecated` for at least two dictionary versions (≥ 6 months)
before removal; the SDK logs a warning once per process per deprecated field; `GET /fields?version=` serves
older versions for the same window. Field ids are stable and never reused.

Core price/book fields: `PX_LAST PX_BID PX_ASK SZ_BID SZ_ASK PX_OPEN PX_HIGH PX_LOW PX_CLOSE PX_PREV_CLOSE
VOLUME VWAP CHG_NET CHG_PCT TICK_DIR IVOL_30D TS_LAST_TRADE SESSION SEQ_SRC PX_LAST_EOD`. Reference:
`NAME TICKER FIGI COMPOSITE_FIGI SHARE_CLASS_FIGI ISIN CUSIP SEDOL CIK LEI MIC EXCH_CODE CRNCY ASSET_CLASS
MKT_SECTOR SECURITY_TYP GICS_SECTOR GICS_INDUSTRY SIC COUNTRY FISCAL_YE SHARES_OUT PUBLIC_FLOAT MKT_CAP
FIRST_TRADE_DT`. Govt: `CPN CPN_FREQ MATURITY ISSUE_DT DAY_CNT YLD_YTM_MID PX_DIRTY ACCRUED DUR_MOD DUR_MAC
CONVEXITY DV01 KRD_2Y KRD_5Y KRD_10Y KRD_30Y DISC_RATE BEY`. Option: `OPT_STRIKE OPT_EXPIRY OPT_PUT_CALL
OPT_UNDL_PX IVOL DELTA GAMMA VEGA THETA RHO OPEN_INT THEO`. Fundamentals: the `fa_line_map.line_id` set
prefixed `FA_` (`FA_REVENUE`, `FA_NET_INCOME`, `FA_EPS_DILUTED`, …) plus `FA_FILED_AT`. Econ: `ECO_VALUE
ECO_PERIOD ECO_VINTAGE ECO_PRIOR ECO_REVISED`. Curve: `CRV_1M … CRV_30Y`. Rate: `RATE PCT_1 PCT_25 PCT_75
PCT_99 VOL_BN TARGET_LO TARGET_HI`. Derived (stats): `RET_1D RET_YTD VOL_30D VOL_90D BETA_1Y CORR_1Y
SHARPE_1Y MAX_DD_1Y`.

## 7. WebSocket protocol (`/ws`)

Text frames, JSON, one message per frame, except `batch`. Field names are short on purpose (10k
subscriptions). Codec in `packages/sdk/src/wire/ws.ts`; server in `packages/server/src/ws/protocol.ts`.

### 7.1 Client → server

```ts
export const Hello = z.object({ t: z.literal('hello'), token: z.string().optional(),   // cookie auth when omitted
  protocol: z.literal(1), conflationMs: z.number().int().min(50).max(5000).default(250), resume: z.boolean().default(false),
  traceId: z.string().optional() });
export const Sub = z.object({ t: z.literal('sub'), id: z.number().int(),               // client-side request id
  subjects: z.array(z.object({ s: z.string(), f: z.array(FieldId).max(100), essential: z.boolean().default(true),
                               known: z.number().int().optional() })).max(10000),      // known = lastSeq (informational; server always snapshots)
  tier: Tier.optional() });
export const Unsub   = z.object({ t: z.literal('unsub'), subjects: z.array(z.string()) });
export const Resync  = z.object({ t: z.literal('resync'), subjects: z.array(z.string()) });
export const SetConf = z.object({ t: z.literal('conflation'), ms: z.number().int().min(50).max(5000) });
export const Essential = z.object({ t: z.literal('essential'), subjects: z.array(z.string()), essential: z.boolean() }); // viewport window changes
export const Ping    = z.object({ t: z.literal('ping'), n: z.number().int() });
```

### 7.2 Server → client

```ts
export const Welcome = z.object({ t: z.literal('welcome'), sessionId: z.string(), serverTime: z.number(), protocol: z.literal(1),
  conflationMs: z.number(), limits: z.object({ maxSubscriptions: z.number(), maxFields: z.number() }), restricted: z.boolean() });
export const Snap = z.object({ t: z.literal('snap'), s: z.string(), seq: z.number().int(), tier: Tier, reason: DowngradeReason,
  f: z.record(FieldId, z.union([z.number(), z.string(), z.null()])), fts: z.record(FieldId, z.number()).optional(),  // per-field src ts (ms)
  ts: z.object({ src: z.number().nullable(), cap: z.number(), pub: z.number() }), st: ValueState, session: z.string(),
  prov: z.object({ p: z.string(), id: z.number(), seq: z.number().optional() }), ac: AssetClass, id: z.string().nullable() });
export const Delta = z.object({ t: z.literal('delta'), s: z.string(), seq: z.number().int(), prev: z.number().int(),
  f: z.record(FieldId, z.union([z.number(), z.string(), z.null()])), fts: z.record(FieldId, z.number()).optional(),
  ts: z.object({ src: z.number().nullable(), cap: z.number(), pub: z.number() }), st: ValueState,
  prov: z.object({ p: z.string(), id: z.number(), seq: z.number().optional() }).optional() });
export const Batch  = z.object({ t: z.literal('batch'), m: z.array(z.union([Snap, Delta, Status])) });
export const Status = z.object({ t: z.literal('status'), s: z.string(), st: z.enum(['pending','stale','halted','closed','blank','shed','gone']),
  reason: z.string().optional(), ts: z.number() });
export const Downgrade = z.object({ t: z.literal('downgrade'), s: z.string().optional(), from: Tier, to: Tier.nullable(), reason: DowngradeReason });
export const ResyncReq = z.object({ t: z.literal('resync'), subjects: z.array(z.string()).optional() });       // server asks client to re-sub (plant restart)
export const Notice = z.object({ t: z.literal('notice'), kind: z.enum(['slow-consumer','overload','maintenance']),
  action: z.enum(['conflation-widened','conflation-restored','shed','disconnect-soon']), conflationMs: z.number().optional(), detail: z.string().optional() });
export const SubAck = z.object({ t: z.literal('subAck'), id: z.number().int(), accepted: z.array(z.string()),
  rejected: z.array(z.object({ s: z.string(), code: z.enum(['NOT_FOUND','NOT_ENTITLED','QUOTA_EXCEEDED','BAD_FIELD','LIMIT']), reason: z.string() })) });
export const Err  = z.object({ t: z.literal('err'), code: z.string(), message: z.string(), traceId: z.string(), fatal: z.boolean() });
export const Pong = z.object({ t: z.literal('pong'), n: z.number().int(), serverTime: z.number() });
```

### 7.3 Sequencing and conflation rules (normative)

1. After `sub`, the server sends `subAck`, then exactly one `snap` per accepted subject (inside `batch` frames),
   then `delta`s. A `snap` carries the full subscribed field set for the granted tier; fields not available
   are `null`.
2. `seq` is the per-subject composite version. `delta.prev` is the `seq` this session last received for the
   subject. Client rule: apply iff `prev === lastSeq`; drop iff `seq <= lastSeq`; otherwise send `resync`.
3. Conflation: at most one `batch` per `conflationMs` per session; a subject appears at most once per batch;
   the values in a delta are the composite's current values at flush time (latest-value guarantee). The
   server may widen `conflationMs` (notice) but never narrows below the client's request.
4. `st` in every frame is the server's staleness verdict at `pub`; the client must recompute after
   `now − ts.src > threshold(tier, session)` (core/staleness.ts) even if no frame arrives.
5. Reconnect: client sends `hello{resume:true}` then re-`sub`s everything with `known`; server responds with
   fresh `snap`s. No delta replay exists; `known` is used only for metrics (gap sizes).
6. Slow consumer: `notice` → `shed` (non-essential subjects get `status{st:'shed'}` and must be re-subscribed
   when they become essential again) → close code `4008`. Other close codes: `4001` unauthenticated, `4003`
   entitlement revoked / session revoked (`takeover`), `4009` concurrent session policy, `4010` protocol
   version unsupported, `4011` subscription limit exceeded.
7. Downgrade reason codes on subscription (ENTL-05): `NOT_ENTITLED_TIER`, `SOURCE_TIER_CAP`, `CONCURRENT_SESSION`,
   `QUOTA_EXCEEDED`, `BLANK_NOT_ENTITLED` (no tier grantable → fields `null`, `st:'blank'`), `TIER_EOD` (field
   not part of the eod view), `PROVIDER_DOWN` (subject known, source failing → last values with `st:'stale'`,
   never silently).
8. Limits: 10,000 subjects per session (BUS-08), 100 fields per subject, `sub` messages ≤ 1 MiB; excess →
   `subAck.rejected[code:'LIMIT']`.

### 7.4 Example exchange

```
→ {"t":"hello","protocol":1,"conflationMs":250}
← {"t":"welcome","sessionId":"…","serverTime":1789497943123,"protocol":1,"conflationMs":250,"limits":{"maxSubscriptions":10000,"maxFields":100},"restricted":false}
→ {"t":"sub","id":1,"subjects":[{"s":"q/BBG000B9XRY4","f":["PX_LAST","PX_BID","PX_ASK","VOLUME","CHG_PCT"]}]}
← {"t":"subAck","id":1,"accepted":["q/BBG000B9XRY4"],"rejected":[]}
← {"t":"batch","m":[{"t":"snap","s":"q/BBG000B9XRY4","seq":4182,"tier":"delayed","reason":"OK",
     "f":{"PX_LAST":330.27,"PX_BID":330.25,"PX_ASK":330.28,"VOLUME":16591786,"CHG_PCT":-0.8436},
     "ts":{"src":1789489586000,"cap":1789497688412,"pub":1789497688413},"st":"delayed","session":"open",
     "prov":{"p":"cboe.quotes","id":88213,"seq":15972883317},"ac":"equity","id":"BBG000B9XRY4"}]}
← {"t":"batch","m":[{"t":"delta","s":"q/BBG000B9XRY4","seq":4185,"prev":4182,"f":{"PX_LAST":330.31,"VOLUME":16601102},
     "ts":{"src":1789489601000,"cap":1789497703400,"pub":1789497703401},"st":"delayed"}]}
```

## 8. Quotas (API-06)

Enforced server-side for `usage:'api'` (Bearer sessions) and reported for all sessions in `SessionInfo.quotas`
and response headers `x-quota-daily-securities: used/limit`, `x-quota-monthly-datapoints: used/limit`,
`x-quota-concurrent-subs: used/limit`. Defaults: 500 unique securities/day, 2,000,000 datapoints/month,
2,000 concurrent subscriptions per API session. Datapoints = rows × columns of series + fields returned.
Exceeding → `429 QUOTA_EXCEEDED` with `details:{metric, used, limit, resetsAt}` and `retryAfterMs`; WS →
`subAck.rejected[code:'QUOTA_EXCEEDED']`. Counters live in `quota_counter`/`quota_unique_security` and are
incremented in the same transaction as the access-log batch.

## 9. Exports

| Route | Notes |
| --- | --- |
| `POST /fn/:code/csv` | CSV of the function payload via `toCsv` (core). Same numbers as the screen: raw values at ≤ 15 significant digits; the screen rounds via the same formatter (FUNC-03). Header row = `csv.columns[].id`; second header row = human labels when `?labels=1`. |
| `POST /data/csv` | Same `DataRequest` body → CSV (long format for multi-security: `security,ts,field,value`). |
| `GET /export/access-log.csv` | compliance/admin: `?from&to&user&licence` |
| `GET /admin/declarations?month=YYYY-MM` | monthly per-licence declaration (JSON or `?format=csv`): `{licence, tier, usage, uniqueUsers, accesses, seats: firm.seat_count, reconciliation}` (ENTL-06, DATA-02) |

Every export re-evaluates entitlement with `usage:'export'` and writes `access_log.purpose='export:<CODE>'`;
licences with `export=false` produce `403 NOT_ENTITLED` with `details.reason='LICENCE_NO_EXPORT'`.

## 10. Workspace, watchlists, portfolios, messaging, alerts, tickets, usage

| Route | Method | Body / response |
| --- | --- | --- |
| `/workspace` | GET | `{ id, name, layout: WorkspaceLayout, version }` (active) |
| `/workspace` | PUT | `{ layout, version }` → `{ version }`; `409 CONFLICT` when `version` is stale (client merges: last-writer-wins per panel) |
| `/workspaces` | GET/POST/DELETE | named layouts |
| `/watchlists` | GET/POST | `{ name, visibility, columns, sort, groupBy }` |
| `/watchlists/:id` | GET/PUT/DELETE | includes `items: [{security: ResolvedRef, position, note}]` |
| `/watchlists/:id/items` | POST/DELETE | `{ securities: SecurityRef[] }` |
| `/portfolios` | GET/POST | `{ name, baseCurrency, benchmarkIndex }` (RLS by firm) |
| `/portfolios/:id/positions` | GET/PUT | lots `[{ lotId, security, quantity, costPrice, costCurrency, tradeDate, settleDate, asOfDate }]` |
| `/portfolios/:id/import` | POST `multipart/form-data` CSV | `{ importId, status, rows, errors[], reconciliation }` (PORT-01) |
| `/portfolios/:id/analytics` | POST `{ asOf, benchmark, scenarios[] }` | → same payload as `PORT` function (single implementation) |
| `/rooms` / `/rooms/:id/messages` | GET/POST | `{ body, shares[], structured? }`; GET paginated `?before&limit`; messages immutable |
| `/rooms/:id/holds` | POST | compliance only |
| `/directory` | GET `?q` | users/firms/desks (MSG-01) |
| `/alerts` | GET/POST/PUT/DELETE | `{ kind, spec, delivery }` |
| `/alerts/events` | GET `?since` | fired events (in-app delivery; email/push are stubs that record delivery attempts) |
| `/saved-searches` | GET/POST/DELETE | |
| `/annotations` | GET `?security` / POST / PUT / DELETE | chart annotations (CHRT-05) |
| `/tickets` | POST `{ panel, fnCode, security, traceId, question, screenState }` | `{ id }` (TERM-09 mechanism) |
| `/usage` | POST `{ events: UsageEvent[] }` | `202` (client-side batched every 5 s; server-side events are written directly) |

`UsageEvent = { ts, kind, panel?, fnCode?, paramsHash?, security?, durationMs?, traceId, details? }`.

## 11. Admin / ops

| Route | Notes |
| --- | --- |
| `GET /admin/licences`, `PUT /admin/licences/:id` | licence registry (admin) |
| `GET/POST/DELETE /admin/entitlements` | grants |
| `GET /admin/access-log?from&to&user&instrument` | paginated |
| `GET /admin/ingest/runs?job&limit`, `POST /admin/ingest/run/:jobId` | scheduler control |
| `GET /admin/dq?open=true` | data-quality results |
| `GET /admin/ca-queue`, `POST /admin/ca-queue/:id/review` | corporate-action exception queue (REF-10 mechanism) |
| `GET /metrics` | Prometheus text (no auth on loopback, token otherwise) |
| `GET /healthz`, `GET /readyz` | liveness/readiness |

## 12. Rate limiting and versioning

* Per-session REST limit 20 req/s burst 60 (`429 RATE_LIMITED`, `retryAfterMs`); `/search` 30 req/s.
* Breaking wire changes bump `x-terminal-protocol`; the server serves N and N−1 concurrently; the SDK pins
  the version it was built for and refuses to talk to an older server (`426`).
