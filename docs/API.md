# API — final HTTP + WebSocket contract

This is the binding wire contract for the terminal clone described in [BRIEF.md](./BRIEF.md) and
[REQUIREMENTS.md](./REQUIREMENTS.md). It agrees by name with [ARCHITECTURE.md](./ARCHITECTURE.md)
(module paths, `QuoteState`, `PayloadMeta`, `ReasonCode`, the WS schemas of §6.4, the evaluator of §10)
and with [DATA_MODEL.md](./DATA_MODEL.md) (every column a route reads or writes). It merges the three
candidate contracts under `docs/design/candidate-{A,B,C}/API.md`: the single `DataRequest` model and
bitemporal `asOf` on every read from A, the route layout, workspace/watchlist shapes, universe snapshot
and CSRF rule from B, the compact WS frames, `prev` chain, `essential` flag and backpressure notices from
C. Where they disagreed the choice is recorded in §13.

Every schema in this document is a zod 4 object under `packages/sdk/src/wire/*.ts` and is the **only**
definition of the wire: `packages/server/src/http/routes/*.ts` validate every request body, query and
param with them and (in dev/test, `VALIDATE_RESPONSES=1`) every response; `packages/sdk/src/client/*.ts`
parse every response with the same objects; `packages/web` never calls `fetch` or `WebSocket` itself
(ARCHITECTURE §1.1). That is how the terminal, the API and the CSV export cannot disagree (API-05).

| Item | Value |
| --- | --- |
| REST base path | `/api/v1` (ARCHITECTURE §15) — every path below is relative to it unless it starts with `/metrics` |
| WebSocket path | `/ws/v1` |
| Encoding | JSON (`application/json; charset=utf-8`) everywhere except `text/csv` exports, `text/plain` `/metrics` and `multipart/form-data` uploads |
| Numbers | JSON numbers, never strings. Entity ids (`instrumentId`, `userId`, …) are JSON numbers (< 2^53, DATA_MODEL §0). Prices/rates come from `numeric` columns parsed once at the API boundary (DATA_MODEL §21) |
| Times | REST: ISO-8601 UTC strings (`2026-09-15T18:41:28.031Z`; dates `2026-09-15`). WS: epoch milliseconds (ARCHITECTURE §15) |
| Trace | request header `x-trace-id` (UUID v4, optional — minted by `http/trace.ts` when absent); always echoed as a response header and in every error and `meta` (OPS-07) |
| Client version | request header `x-client-version: <package>/<semver>` (`web/0.1.0`, `sdk-js/0.1.0`); response header `x-server-version` (§11) |
| Pagination | cursor based: request `cursor?`, `limit?`; response `{ items, nextCursor: string \| null }` |
| Sections | §1 auth · §2 errors · §3 common types · §4 `DataRequest` · §5 REST routes · §6 WebSocket · §7 field dictionary · §8 quotas · §9 export · §10 SDK · §11 versioning · §12 examples · §13 decisions · §14 open questions |

File map (`packages/sdk/src/`):

```
wire/envelope.ts      ErrorEnvelope, ErrorCode, Meta, PayloadMeta, AsOf, ProvenanceRef, EntitlementNote, UnavailableNote   (§2, §3)
wire/common.ts        AssetClass, MarketSector, Tier, ValueState, SessionState, UsageType, FieldId, SubjectId, SecurityRefInput,
                      ResolvedRef, InstrumentSummary, FieldValue, AdjustPolicy, BarInterval                                  (§3)
wire/reasonCodes.ts   ReasonCode (mirrors core/types/entitlement.ts)                                                          (§3)
wire/dataRequest.ts   DataRequest, DataResponse, SeriesBlock, TickRow, RealtimeSubject                                       (§4)
wire/rest.ts          Rest.<Route>.{params,query,body,response} for every row of §5; zod 4 objects
wire/ws.ts            ClientMsg, ServerMsg, Snap, Delta, Status, close codes, subject grammar, per-subject field sets     (§6)
fields/fields.json    generated from core/fields/dictionary.ts (§7); fields/index.ts typed accessors + format()
client/rest.ts        RestClient · client/ws.ts LiveClient · client/subscriptions.ts · client/quoteCache.ts           (§10)
functions/index.ts    FunctionRegistry re-export + runFunction()                                                          (§10)
index.ts              createClient(), TerminalClient, every schema and type                                               (§10)
```

---

## 1. Auth and session model (SEC-01, SEC-02, SEC-03, ENTL-03, API-01)

### 1.1 What ships

| Item | Decision |
| --- | --- |
| Identity | One `users` row per natural person (DATA_MODEL §11): `email` (the login name), `display_name`, `firm_id`, `role ∈ user \| admin \| compliance \| dataops \| helpdesk \| newsroom`, `status`, `mfa_required`, `person_verified_at` (SEC-01 onboarding evidence recorded by an admin; SSO/SCIM is out of scope — `scim_external_id` is reserved). |
| Dev-mode login (shipped) | `POST /auth/login` with `email` + `password`. Password hash is `crypt(password, gen_salt('bf', 12))` in `user_credentials.secret_hash` (`kind='password'`), verified with `crypt(password, secret_hash) = secret_hash` inside `http/auth/password.ts`. Seeded users come from `fixtures/seed/users.json` (SEC-01 substitute). |
| WebAuthn (optional, shipped) | FIDO2 registration and assertion in `http/auth/webauthn.ts` (SEC-02) using the W3C JSON shapes (`PublicKeyCredentialCreationOptionsJSON`, `RegistrationResponseJSON`, `PublicKeyCredentialRequestOptionsJSON`, `AuthenticationResponseJSON`) stored in `user_credentials` (`kind='webauthn'`, `credential_id`, `public_key`, `sign_count`, `transports`, `aaguid`). When `users.mfa_required = true` (seed: `admin`, `compliance`) a password login yields a session with `mfaVerified=false` that may only call `/auth/*`; every other route returns `401 MFA_REQUIRED` until `/auth/webauthn/login/verify` succeeds. Passwordless login (`/auth/webauthn/login/options` + `verify` without a prior password step) is also accepted. |
| Session token (web) | opaque 32 random bytes, base64url, delivered as cookie `tsid`; the server stores only `digest(token,'sha256')` in `sessions.token_hash`. Cookie attributes: `HttpOnly; SameSite=Strict; Path=/; Secure` (Secure omitted only when `NODE_ENV=development` on `http://localhost`). Sliding expiry 12 h (`last_seen_at`), absolute 7 d (`expires_at`); `revoke_reason ∈ logout \| superseded \| expired \| admin \| deprovisioned`. |
| CSRF | `SameSite=Strict` plus: every cookie-authenticated request with a method other than GET/HEAD/OPTIONS must carry `x-requested-with: terminal`, otherwise `403 CSRF_REJECTED`. Bearer requests are exempt. |
| API keys (API-01 desktop + server API) | `Authorization: Bearer tk_<base64url 32 bytes>`; `api_keys.key_hash = digest(key,'sha256')`, bound to a `user_id` (a natural person, ENTL-03) with `scopes` default `{data:read,fn:run,ws:subscribe}`. The first use of a key creates a `sessions` row with `client_kind='api'`, `api_key_id`, 24 h sliding expiry; API sessions never supersede web sessions and are subject to the API quotas (§8). Unattended "server" keys are the same object minted for a user with `role='user'` and `scopes` containing `server` — priced separately per API-01, enforced only by the scope flag. |
| Concurrent sessions (SEC-03, ENTL-03) | The partial unique index `sessions_one_active_web` allows one active web session per user. A new web login, in one transaction, sets `revoked_at=now(), revoke_reason='superseded'` on the existing one and inserts the new row; the displaced WebSocket receives `bye 4003 SESSION_SUPERSEDED`; an `access_log` row with `decision='deny', reason='CONCURRENT_SESSION', purpose='auth.login'` is written and `sessions.superseded_count` is incremented. The login response reports what was displaced (`superseded`). There is no "restricted" third mode (ARCHITECTURE §15). |
| Deprovisioning | `users.status='deprovisioned'` revokes every session (`revoke_reason='deprovisioned'`) and API key immediately (SEC-01). |
| Request context | Every authenticated request runs in a transaction with `set_config('app.user_id'\|'app.firm_id'\|'app.role', …, true)` so RLS (DATA_MODEL §15) applies (PORT-07, SEC-05). |
| WebSocket auth | The `tsid` cookie is read on the HTTP upgrade of `/ws/v1`; bearer clients omit the cookie and send `hello.token`. A socket that has not sent `hello` within 5 s, or whose session is invalid, is closed with `4001 AUTH_REQUIRED`. |

### 1.2 Schemas — `wire/rest.ts` (`Rest.Auth.*`)

```ts
import { z } from 'zod';

export const Role = z.enum(['user','admin','compliance','dataops','helpdesk','newsroom']);
export const ClientKind = z.enum(['web','api']);

export const LoginRequest = z.object({
  email: z.email(),
  password: z.string().min(8).max(256),
  deviceId: z.string().min(8).max(64),          // client-generated stable id (localStorage); stored in sessions.device_id
  deviceLabel: z.string().max(80).optional(),   // 'Chrome on macOS'
});

export const QuotaUsage = z.object({ used: z.number().int(), limit: z.number().int(), resetsAt: z.iso.datetime() });
export const SessionInfo = z.object({
  sessionId: z.uuid(),
  userId: z.number().int(), firmId: z.number().int(), firmName: z.string(),
  email: z.email(), displayName: z.string(), desk: z.string().nullable(), role: Role,
  clientKind: ClientKind,
  mfaRequired: z.boolean(), mfaVerified: z.boolean(), webauthnEnrolled: z.boolean(),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  entitlementSummary: z.object({                // from the evaluator's cache for this user (ARCHITECTURE §10)
    defaultTier: z.enum(['eod','delayed','realtime']),   // min over the user's grants; 'delayed' for every seeded user
    exportAllowed: z.boolean(), apiAllowed: z.boolean(),
  }),
  quotas: z.object({ dailyUniqueInstruments: QuotaUsage, monthlyDataPoints: QuotaUsage, concurrentSubscriptions: QuotaUsage }),
  protocol: z.literal(1),                       // WS protocol the server speaks (§11)
  serverVersion: z.string(), minClientVersion: z.string(), dictionaryVersion: z.string(),
});

export const LoginResponse = z.object({
  session: SessionInfo,
  mfaRequired: z.boolean(),                     // true → only /auth/* is usable until webauthn/login/verify
  superseded: z.object({ sessionId: z.uuid(), deviceId: z.string().nullable(), deviceLabel: z.string().nullable(),
                         lastSeenAt: z.iso.datetime() }).nullable(),   // the web session this login displaced (SEC-03)
});

export const ApiKeyCreate   = z.object({ label: z.string().min(1).max(80), scopes: z.array(z.enum(['data:read','fn:run','ws:subscribe','server'])).default(['data:read','fn:run','ws:subscribe']) });
export const ApiKeySummary  = z.object({ apiKeyId: z.number().int(), label: z.string(), scopes: z.array(z.string()), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable() });
export const ApiKeyCreated  = ApiKeySummary.extend({ secret: z.string() });   // 'tk_…' shown exactly once
export const SessionSummary = z.object({ sessionId: z.uuid(), clientKind: ClientKind, deviceId: z.string().nullable(), deviceLabel: z.string().nullable(),
                                         ip: z.string().nullable(), createdAt: z.iso.datetime(), lastSeenAt: z.iso.datetime(), current: z.boolean() });
```

### 1.3 Routes (`http/routes/auth.ts`)

| Method | Path | Request | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | `/auth/login` | `LoginRequest` | `200 LoginResponse` + `Set-Cookie: tsid` | `401 AUTH_INVALID_CREDENTIALS` (same message for unknown email and wrong password); `403 USER_SUSPENDED`; rate limit 5/min per IP → `429 RATE_LIMITED` |
| POST | `/auth/logout` | — | `204` + cookie cleared | `revoke_reason='logout'`; open WS gets `bye 1000 'logout'` |
| GET | `/auth/session` | — | `200 SessionInfo` | works for cookie and bearer; refreshes `last_seen_at` |
| GET | `/auth/sessions` | — | `200 { items: SessionSummary[] }` | own sessions (web + api) |
| DELETE | `/auth/sessions/:sessionId` | — | `204` | revoke one of your own sessions (`revoke_reason='logout'`) |
| POST | `/auth/webauthn/register/options` | `{}` | `200 PublicKeyCredentialCreationOptionsJSON` | requires an authenticated (password) session; challenge cached 5 min per session |
| POST | `/auth/webauthn/register/verify` | `{ credential: RegistrationResponseJSON, label?: string }` | `200 { credentialId: string }` | inserts `user_credentials kind='webauthn'` |
| POST | `/auth/webauthn/login/options` | `{ email: z.email() }` | `200 { challengeId: uuid, options: PublicKeyCredentialRequestOptionsJSON }` | allowCredentials from the user's registered keys; identical response shape for unknown emails |
| POST | `/auth/webauthn/login/verify` | `{ challengeId: uuid, credential: AuthenticationResponseJSON, deviceId, deviceLabel? }` | `200 LoginResponse` | upgrades the current session to `mfa_verified=true`, or creates one (passwordless); updates `sign_count`, `last_used_at` |
| GET | `/auth/api-keys` | — | `200 { items: ApiKeySummary[] }` | own keys |
| POST | `/auth/api-keys` | `ApiKeyCreate` | `201 ApiKeyCreated` | requires a web session with `mfaVerified` when `mfa_required`; `scopes` containing `server` requires `role='admin'` |
| DELETE | `/auth/api-keys/:apiKeyId` | — | `204` | sets `revoked_at`; its api session is revoked (`revoke_reason='admin'`) |

Required headers summary: cookie sessions — `Cookie: tsid=…` plus `x-requested-with: terminal` on mutations; bearer sessions — `Authorization: Bearer tk_…`. Both — optional `x-trace-id`, recommended `x-client-version`.

---

## 2. Error envelope

`packages/server/src/http/errors.ts` maps the `AppError` hierarchy to exactly this body; `wire/envelope.ts`
holds the schema; `client/rest.ts` turns it into a typed `TerminalApiError` (§10).

```ts
export const ErrorCode = z.enum([
  // 400
  'VALIDATION_FAILED',        // zod parse failure — details.issues: z.core.$ZodIssue[]; details.location: 'body'|'query'|'params'|'fnParams'
  'BAD_REQUEST',
  // 401
  'AUTH_REQUIRED', 'AUTH_INVALID_CREDENTIALS', 'SESSION_EXPIRED', 'SESSION_SUPERSEDED', 'MFA_REQUIRED',
  // 403
  'FORBIDDEN',                // role or scope — details.requiredRole | details.requiredScope
  'CSRF_REJECTED',
  'USER_SUSPENDED',
  'ENTITLEMENT_DENIED',       // whole request denied — details.reasons: EntitlementNote[] (§3); partial denials are per-field, HTTP 200
  'MESSAGE_POLICY_BLOCKED',   // MSG-03 — details.rule: 'counterparty'|'ethical_wall'|'external'|'legal_hold'
  // 404
  'NOT_FOUND', 'SECURITY_NOT_FOUND', 'FUNCTION_NOT_FOUND', 'FIELD_UNKNOWN', 'RESULT_EXPIRED',
  // 409
  'AMBIGUOUS_SECURITY',       // details.candidates: InstrumentSummary[]
  'WORKSPACE_VERSION_CONFLICT', // details.current: Workspace (the server copy)
  'DUPLICATE_NAME',
  // 422
  'FUNCTION_NOT_APPLICABLE',  // FUNC-02 — details.assetClass, details.applicable: AssetClass[]
  'NOT_IN_UNIVERSE',          // sector parsed (e.g. 'Corp') but no data source in the wedge
  'NO_SECURITY_CONTEXT',      // manifest.requiresSecurity and no security supplied
  // 426
  'PROTOCOL_VERSION',
  // 429
  'QUOTA_EXCEEDED',           // details: { quota: 'dailyUniqueInstruments'|'monthlyDataPoints'|'concurrentSubscriptions', used, limit, resetsAt }
  'RATE_LIMITED',
  // 500 / 503
  'INTERNAL', 'REPLAY_MISS', 'PROVIDER_UNAVAILABLE', 'STARTING',
]);

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),                        // human text, shown verbatim in the panel footer
    traceId: z.uuid(),
    retryable: z.boolean(),                     // true only for PROVIDER_UNAVAILABLE, STARTING, RATE_LIMITED, QUOTA_EXCEEDED
    retryAfterMs: z.number().int().optional(),  // 429 / 503; also sent as the Retry-After header (seconds)
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
```

| HTTP | Codes | Notes |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED`, `BAD_REQUEST` | function parameter grammar failures are `VALIDATION_FAILED` with `details.location='fnParams'` and `details.grammar` (the manifest `paramGrammar`) |
| 401 | `AUTH_REQUIRED`, `AUTH_INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `SESSION_SUPERSEDED`, `MFA_REQUIRED` | `SESSION_SUPERSEDED` carries `details.supersededBy: { deviceLabel, createdAt }` so the client can say who logged in (SEC-03) |
| 403 | `FORBIDDEN`, `CSRF_REJECTED`, `USER_SUSPENDED`, `ENTITLEMENT_DENIED`, `MESSAGE_POLICY_BLOCKED` | `ENTITLEMENT_DENIED` is used when no requested field is servable, or on export when any field is denied (§9) |
| 404 | `NOT_FOUND`, `SECURITY_NOT_FOUND`, `FUNCTION_NOT_FOUND`, `FIELD_UNKNOWN`, `RESULT_EXPIRED` | tenant-isolated rows the caller may not see are `NOT_FOUND`, never 403 (RLS returns zero rows) |
| 409 | `AMBIGUOUS_SECURITY`, `WORKSPACE_VERSION_CONFLICT`, `DUPLICATE_NAME` | |
| 422 | `FUNCTION_NOT_APPLICABLE`, `NOT_IN_UNIVERSE`, `NO_SECURITY_CONTEXT` | |
| 426 | `PROTOCOL_VERSION` | `x-client-version` below `minClientVersion` for a breaking change (§11) |
| 429 | `QUOTA_EXCEEDED`, `RATE_LIMITED` | `Retry-After` header |
| 500 | `INTERNAL`, `REPLAY_MISS` | `REPLAY_MISS` only in `PROVIDER_MODE=replay` (a fixture is missing — tests fail loudly, never touch the network) |
| 503 | `PROVIDER_UNAVAILABLE`, `STARTING` | a live read-through was required and the provider circuit is open (`details.sourceId`); `STARTING` until startup step 8 (ARCHITECTURE §12.1) |

Every response — success or error — carries `x-trace-id`. Errors never carry data; partial data with
per-field reasons is always a `200` with `r`/`meta.entitlement` populated (ENTL-05).

---
## 3. Common wire types — `wire/common.ts`, `wire/envelope.ts`, `wire/reasonCodes.ts`

```ts
// wire/common.ts — enums are byte-identical to core/types/*.ts and the Postgres enums in DATA_MODEL §1
export const AssetClass   = z.enum(['equity','etf','index','fx','govt','option','future','crypto','rate','econ']);
export const MarketSector = z.enum(['Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto']);
export const Tier         = z.enum(['eod','delayed','realtime']);                       // ordered eod < delayed < realtime
export const ValueState   = z.enum(['live','stale','closed','blank','na']);              // TERM-12; tier is carried separately
export const SessionState = z.enum(['pre','open','auction','halted','closed','post','unknown']);
export const UsageType    = z.enum(['display','export','api']);
export const FieldClass   = z.enum(['price','reference','fundamental','econ','news','analytic','derived','portfolio']);
export const AdjustPolicy = z.enum(['unadjusted','price','total_return']);              // REF-09; the only three (DATA_MODEL §20)
export const BarInterval  = z.enum(['1m','5m','1d']);                                    // core/types/bars.ts
export const Periodicity  = z.enum(['D','W','M','Q','Y']);                               // resampled from '1d' bars on read
export const FieldId      = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);                  // 'PX_LAST'; validated against the dictionary at runtime
export const SubjectId    = z.string().regex(/^(q|l|b1m|oc|c|r|e|n|alerts|room|sys):[A-Za-z0-9_.:-]+$/);   // ARCHITECTURE §6.1
export const FieldValue   = z.union([z.number(), z.string(), z.boolean(), z.null()]);   // null = blank/denied/unknown; reason in `r`

/** How a security is addressed anywhere in the API. Exactly one form. */
export const SecurityRefInput = z.union([
  z.object({ id: z.number().int().positive() }),        // instrumentId (immutable internal key, REF-01)
  z.object({ ref: z.string().min(1).max(120) }),         // command-line form parsed by core/ids/securityRef.ts:
                                                         //   'AAPL US Equity' · 'AAPL Equity' · 'SPX Index' · 'EURUSD Curncy' · '912797VE4 Govt' ·
                                                         //   'T 4.25 08/15/36 Govt' · 'AAPL 9/16/26 C245 Equity' · 'SOFR Index' · 'CPIAUCSL Index' ·
                                                         //   '/isin/US0378331005' · '/figi/BBG000B9XRY4' · '/cusip/037833100' · '/occ/AAPL260916C00245000' · '/series/fred.csv/DGS10'
  z.object({ formula: z.string().min(3).max(400) }),     // CHRT-07 computed series, core/formula: 'RATIO(AAPL US Equity, SPX Index)'
]);

/** core/types/instrument.ts ResolvedRef, verbatim, plus the display columns every list needs. */
export const ResolvedRef = z.object({
  instrumentId: z.number().int(), assetClass: AssetClass, marketSector: MarketSector,
  display: z.string(),                                   // 'AAPL US Equity'
  name: z.string(), currency: z.string().length(3),
  primaryListingId: z.number().int().optional(), mdLineIds: z.array(z.number().int()),
});
export const InstrumentSummary = ResolvedRef.extend({
  ticker: z.string(), exchCode: z.string(), securityType: z.string(),
  compositeFigi: z.string().length(12).nullable(),
  status: z.enum(['active','delisted','pending','matured','expired']),
  priceDecimals: z.number().int(),                       // instruments.price_decimals (display hint; the formatter decides)
});

// wire/reasonCodes.ts — mirrors core/types/entitlement.ts ReasonCode (ARCHITECTURE §10) exactly
export const ReasonCode = z.enum(['OK','SOURCE_TIER_CAP','NOT_ENTITLED_TIER','NO_FIRM_ENTITLEMENT','NO_USER_ENTITLEMENT',
  'LICENCE_FORBIDS_USAGE','TIER_EOD','CONCURRENT_SESSION','QUOTA_EXCEEDED','PROVIDER_DOWN','SUBJECT_UNKNOWN','FIELD_UNKNOWN','NOT_IN_UNIVERSE']);
```

| ReasonCode | Meaning on the wire (ENTL-05) |
| --- | --- |
| `OK` | served at the requested tier |
| `SOURCE_TIER_CAP` | licence `max_tier` below the request (every v1 source is ≤ `delayed`): served at the cap |
| `NOT_ENTITLED_TIER` | firm/user grant below the request: served at the grant tier |
| `NO_FIRM_ENTITLEMENT` / `NO_USER_ENTITLEMENT` | no grant for (source, field class): field is `null`, `st:'blank'` |
| `LICENCE_FORBIDS_USAGE` | registry forbids this usage (`export_allowed`/`api_allowed` false): request refused (403) |
| `TIER_EOD` | granted tier is `eod` and the field is not part of the end-of-day view: `null` |
| `CONCURRENT_SESSION` | login superseded (audit row only; never a field reason) |
| `QUOTA_EXCEEDED` | API-06 quota hit (429 / `subAck.rejected`) |
| `PROVIDER_DOWN` | subject known, source circuit open: last values with `st:'stale'`, never silently |
| `SUBJECT_UNKNOWN` / `FIELD_UNKNOWN` / `NOT_IN_UNIVERSE` | subscription/resolution rejections |

```ts
// wire/envelope.ts — Meta is the same object on REST data responses, function payloads and CSV headers (ARCHITECTURE §5.3)
export const AsOf = z.object({ validAt: z.iso.datetime().optional(), knownAt: z.iso.datetime().optional() });   // request side; defaults now/now
export const ProvenanceRef   = z.object({ idx: z.number().int(), sourceId: z.string(), provenanceId: z.number().int(),
                                          capturedAt: z.iso.datetime(), sourceTs: z.iso.datetime().nullable(), attribution: z.string(),
                                          requestKey: z.string().optional() /* replay-store key; admin/dataops roles only */ });
export const EntitlementNote = z.object({ fieldId: FieldId, decision: z.enum(['downgrade','deny']), effectiveTier: Tier.nullable(), reason: ReasonCode });
export const UnavailableNote = z.object({ field: z.string(), reason: z.enum(['NO_SOURCE','NOT_LICENSED','NOT_APPLICABLE']), detail: z.string() });
export const EngineNote      = z.object({ name: z.string(), version: z.string(), inputsHash: z.string().length(64) });   // ANAL-08
export const PageInfo        = z.object({ index: z.number().int(), count: z.number().int(), cursor: z.string().nullable() });
export const AdjustmentStep  = z.object({ beforeDate: z.iso.date(), priceFactor: z.number(), volumeFactor: z.number(), kind: z.enum(['split','dividend','capital_return']) });

export const Meta = z.object({
  traceId: z.uuid(),
  asOf: z.object({ validAt: z.iso.datetime(), knownAt: z.iso.datetime() }),   // the EFFECTIVE values (REF-03, STOR-06)
  tier: Tier,                                             // lowest tier among cited values
  staleness: ValueState,                                  // worst ValueState among cited values (TERM-12)
  provenance: z.array(ProvenanceRef),                     // every value block cites an idx into this (DATA-10)
  entitlement: z.array(EntitlementNote),                  // downgrades and denials (ENTL-05)
  unavailable: z.array(UnavailableNote),                  // e.g. EE estimates: NO_SOURCE (BRIEF §2)
  engines: z.array(EngineNote),
  adjustments: z.array(AdjustmentStep).optional(),        // historical reads only (REF-09)
  page: PageInfo.optional(),
  servedAt: z.iso.datetime(),
  quota: z.object({ dataPointsCharged: z.number().int(), uniqueInstrumentsAdded: z.number().int() }).optional(),   // API-06 (api sessions)
});
export const PayloadMeta = Meta.extend({ resultId: z.string() });    // core/types/function.ts PayloadMeta; resultId = ULID of the cached result
```

---

## 4. The one request model — `wire/dataRequest.ts` (API-02)

`POST /data` is the single data endpoint; the five kinds share `securities`, `fields`, `asOf` and
`usage`, and return one `DataResponse`. `kind:'realtime'` is the same object the SDK turns into a WS
`sub` (§6, §10): on REST it returns the plant's current entitlement-filtered view (one-shot) plus the
subjects to subscribe to, so a caller can prime a grid and then stream without a second vocabulary.
Convenience GETs (§5.4) build the same object and go through the same dispatcher
(`server/src/data/request.ts`).

```ts
const Base = z.object({
  securities: z.array(SecurityRefInput).min(1),
  fields: z.array(FieldId).min(1),
  asOf: AsOf.optional(),                                 // REF-03: validAt = "as of when in the world", knownAt = "as of what we knew"
  usage: UsageType.default('display'),                   // bearer sessions are forced to 'api'; export routes force 'export'
});

export const DataRequest = z.discriminatedUnion('kind', [
  Base.extend({ kind: z.literal('reference'),                         // security master, terms, classifications, PIT fundamentals
    securities: z.array(SecurityRefInput).min(1).max(500), fields: z.array(FieldId).min(1).max(200) }),
  Base.extend({ kind: z.literal('historical'),                        // bars_daily resampled; corporate actions applied on read (REF-09)
    securities: z.array(SecurityRefInput).min(1).max(50), fields: z.array(FieldId).min(1).max(20).default(['PX_OPEN','PX_HIGH','PX_LOW','PX_LAST','PX_VOLUME']),
    start: z.iso.date(), end: z.iso.date().optional(),                // end defaults to validAt's date
    periodicity: Periodicity.default('D'),
    adjust: AdjustPolicy.default('price'),
    currency: z.string().length(3).optional(),                        // convert via fx_rates at each session date
    fill: z.enum(['none','prev']).default('none'),
    calendarAlign: z.enum(['primary','union','intersection']).default('primary') }),   // CHRT-03 multi-security alignment
  Base.extend({ kind: z.literal('intraday'),                          // bars_intraday
    securities: z.array(SecurityRefInput).min(1).max(20), fields: z.array(FieldId).min(1).max(10).default(['PX_OPEN','PX_HIGH','PX_LOW','PX_LAST','PX_VOLUME']),
    start: z.iso.datetime(), end: z.iso.datetime().optional(),
    interval: z.enum(['1m','5m','15m','1h']).default('1m'),           // 15m/1h resampled from 5m/1m on read
    session: z.enum(['regular','extended']).default('regular') }),
  Base.extend({ kind: z.literal('tick'),                              // quote_ticks (delayed observations, STOR-01 analogue)
    securities: z.array(SecurityRefInput).min(1).max(5), fields: z.array(FieldId).min(1).max(20).default(['PX_LAST','LAST_SIZE','PX_BID','PX_ASK','BID_SIZE','ASK_SIZE','PX_VOLUME']),
    start: z.iso.datetime(), end: z.iso.datetime(),
    kinds: z.array(z.enum(['trade','quote','summary'])).default(['trade','quote']),
    limit: z.number().int().min(1).max(100000).default(10000), cursor: z.string().optional() }),
  Base.extend({ kind: z.literal('realtime'),                          // plant view now (REST) / subscription (WS)
    securities: z.array(SecurityRefInput).min(1).max(10000), fields: z.array(FieldId).min(1).max(100),
    tier: Tier.optional(),                                            // requested; effective tier is per-field in the response
    conflationMs: z.number().int().min(50).max(5000).optional(),      // used by the SDK when it opens the subscription
    subjectKind: z.enum(['q','l','b1m','oc']).default('q') }),        // which subject family to map securities onto (§6.1)
]);

export const SeriesBlock = z.object({                                 // historical / intraday: column-major-friendly, one block per security
  columns: z.array(FieldId),
  index: z.array(z.string()),                                         // 'YYYY-MM-DD' (historical) or ISO datetime (intraday, bar start UTC)
  rows: z.array(z.array(z.number().nullable())),                      // rows[i][j] = value of columns[j] at index[i]
  adjust: AdjustPolicy.optional(), currency: z.string().length(3),
  provIdx: z.array(z.number().int()),                                 // meta.provenance indexes cited by this block
});
export const TickRow = z.object({                                     // quote_ticks columns (DATA_MODEL §7.2)
  capTs: z.iso.datetime(), srcTs: z.iso.datetime().nullable(), pubTs: z.iso.datetime().nullable(),   // FEED-05
  kind: z.enum(['trade','quote','summary']), srcSeq: z.number().int().nullable(), mdLineId: z.number().int(),
  f: z.record(z.string(), FieldValue),                                // the requested fields present on this tick
  conditions: z.array(z.string()), provIdx: z.number().int(),
});
export const RealtimeSubject = z.object({ subject: SubjectId, fields: z.array(FieldId), tier: Tier, reason: ReasonCode });

export const DataResult = z.object({
  security: SecurityRefInput,                                         // echoed request
  instrument: InstrumentSummary.nullable(),                           // null + error when unresolved
  error: z.object({ code: ErrorCode, message: z.string(), candidates: z.array(InstrumentSummary).optional() }).optional(),
  // kind:'reference' | 'realtime'
  fields: z.record(z.string(), FieldValue).optional(),                // null = blank (see r) or not applicable
  r:      z.record(z.string(), ReasonCode).optional(),                // per-field reason when null (ENTL-05)
  fts:    z.record(z.string(), z.iso.datetime()).optional(),          // per-field source timestamp
  fprov:  z.record(z.string(), z.number().int()).optional(),          // per-field provenance idx (reference: each field may come from a different source)
  // kind:'historical' | 'intraday'
  series: SeriesBlock.optional(),
  // kind:'tick'
  ticks: z.array(TickRow).optional(), nextCursor: z.string().nullable().optional(),
  // kind:'realtime'
  subject: RealtimeSubject.optional(),
  tier: Tier, st: ValueState, session: SessionState.optional(),
  ts: z.object({ src: z.iso.datetime().nullable(), cap: z.iso.datetime(), pub: z.iso.datetime() }).optional(),   // FEED-05 (reference/realtime)
});
export const DataResponse = z.object({ meta: Meta, results: z.array(DataResult) });
```

Rules:

1. Resolution is as-of `asOf` (REF-03): `{ ref:'AAPL US Equity' }` on `validAt=2010-06-01` resolves to
   whatever `identifiers` said then. Ambiguity (`'AAPL Equity'` matching two composites) yields
   `error.code='AMBIGUOUS_SECURITY'` with `candidates` for that result only; the request as a whole is `200`.
2. Entitlement runs once per request over `securities × fields × tier × usage` before any service read
   (ENTL-01); denied fields are `null` with `r[field]`; a request in which **no** field is servable is
   `403 ENTITLEMENT_DENIED`. Every decision is one `access_log` row with `purpose='data.<kind>'` (ENTL-04).
3. `historical`: stored bars are unadjusted; `adjust` applies factors from `corporate_actions` **as-of
   `asOf.knownAt`** (DATA_MODEL §6.1); the steps used are echoed in `meta.adjustments`. `fields` may
   include `PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME, VWAP, PX_OFFICIAL_CLOSE, TOT_RETURN_INDEX`
   for bars, or any `econ`/`rate`/`curve` field for `econ`/`rate` instruments (`ECO_VALUE` vintages honour `knownAt`).
4. `reference` fields with `pit=true` in the dictionary (fundamentals, econ) are read at `knownAt`
   (`xbrl_facts.filed_at <= knownAt`, STOR-06). `meta.asOf` always reports the effective pair.
5. `tick` results are ordered by `capTs` ascending and paginated with `nextCursor`; the p95 budget for one
   session of one name is 2 s (NFR).
6. `realtime` on REST costs one `PlantReader.snapshotMany()`; cold subjects are added to the hot set and
   return `st:'blank'` with `r[*]='PROVIDER_DOWN'` only if the read-through fetch fails.
7. Quota charge (API-06): reference/realtime `securities × fields`; historical/intraday `rows × columns`;
   tick `ticks.length`; reported in `meta.quota`. Limits are checked **before** any fetch.

---
## 5. REST route table

Every route requires an authenticated session unless marked *public*. `Role` column: `any` = any
authenticated user; otherwise the `users.role` values allowed. Route files are those listed in
ARCHITECTURE §3.3 (`http/routes/<file>.ts`); schemas are `Rest.<Group>.<Name>` in `wire/rest.ts`.

### 5.1 Resolution and reference (`reference.ts`) — REF-01, REF-02, REF-03, REF-04, REF-05, REF-06, REF-07, REF-08, REF-09

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/ref/resolve` | query `ref` (string), `validAt?`, `knownAt?`, `panelSecurityId?` (TERM-03 context: prefer the same exchange/sector) | `200 ResolveResponse` (single item) | any |
| POST | `/ref/resolve` | `{ refs: z.array(SecurityRefInput).min(1).max(200), asOf?: AsOf, panelSecurityId?: number }` | `200 ResolveResponse` | any |
| GET | `/ref/:instrumentId` | `validAt?`, `knownAt?` | `200 { meta, instrument: Instrument, issue: Issue, issuer: Issuer, listings: Listing[], mdLines: MdLine[], terms: Terms \| null, classifications: Classification[], identifiers: Identifier[] }` — TS shapes are the `Bitemporal`-extending interfaces of ARCHITECTURE §4.1 serialised camelCase; `terms` is `GovtTerms \| OptionTerms \| FutureTerms \| FundTerms \| IndexTerms \| FxTerms \| RateTerms` discriminated by `kind` | any |
| GET | `/ref/:instrumentId/identifiers` | `validAt?`, `knownAt?` | `200 { meta, identifiers: Identifier[] }` | any |
| GET | `/ref/:instrumentId/versions` | `table: z.enum(['instruments','issues','issuers','listings','md_lines','identifiers','govt_terms','option_terms','future_terms','index_members','corporate_actions']).default('instruments')`, `limit≤500` | `200 { meta, versions: VersionRow[] }` — the bitemporal audit view ("what did we believe on 14 March as of 5 March", REF-03) | any |
| GET | `/ref/:instrumentId/corporate-actions` | `from?`, `to?` (dates), `status?[]`, `validAt?`, `knownAt?` | `200 { meta, actions: CorporateAction[] }` (DATA-08) | any |
| GET | `/ref/:instrumentId/terms` | as-of | `200 { meta, terms }` (REF-04/05) | any |
| GET | `/issuers/:issuerId` | as-of | `200 { meta, issuer: Issuer, instruments: InstrumentSummary[], people: Person[], relations: EntityRelation[], aliases: string[] }` (REF-08) | any |
| GET | `/calendars/:calendarId` | `from`, `to` (dates, ≤ 5 years) | `200 { calendarId, holidays: [{ day, name, kind:'holiday'\|'early_close', closeTimeLocal? }], sessions: [{ weekday, openLocal, closeLocal, preOpenLocal?, postCloseLocal? }], tz }` (REF-06) | any |
| GET | `/indices/:instrumentId/members` | `asOfDate?` (date; default today), `validAt?`, `knownAt?`, `source?: 'sec.archives'\|'ssga.holdings'` | `200 { meta, asOfDate, members: [{ instrument: InstrumentSummary, weight, shares, marketValue, sourceId }] }` (REF-07, MEMB) | any |
| GET | `/classifications/:scheme` | `scheme ∈ sic\|naics\|gics\|internal`, `code?` | `200 { scheme, nodes: [{ code, name, parentCode }] }` | any |

```ts
export const ResolveItem = z.object({
  ref: SecurityRefInput,
  instrument: InstrumentSummary.nullable(),
  candidates: z.array(InstrumentSummary),                 // non-empty when ambiguous or not found (best matches, ≤ 8)
  error: z.object({ code: z.enum(['SECURITY_NOT_FOUND','AMBIGUOUS_SECURITY','NOT_IN_UNIVERSE']), message: z.string() }).optional(),
  source: z.enum(['master','openfigi','yahoo']).default('master'),   // a miss may be filled from OpenFIGI mapping → master row created (REF-01); Yahoo hits are never auto-added
});
export const ResolveResponse = z.object({ meta: Meta.pick({ traceId: true, asOf: true, servedAt: true }), results: z.array(ResolveItem) });

export const Identifier = z.object({ scheme: z.enum(['FIGI','COMPOSITE_FIGI','SHARE_CLASS_FIGI','ISIN','CUSIP','SEDOL','RIC','TICKER_EXCH','LEI','MIC','CIK','OCC','PROVIDER_SYMBOL','SERIES_CODE']),
  value: z.string(), qualifier: z.string(), isPrimary: z.boolean(), validFrom: z.iso.datetime(), validTo: z.iso.datetime() });
export const VersionRow = z.object({ versionId: z.number().int(), validFrom: z.iso.datetime(), validTo: z.iso.datetime(), txFrom: z.iso.datetime(), txTo: z.iso.datetime(),
  provenance: ProvenanceRef, data: z.record(z.string(), z.unknown()) });
export const CorporateAction = z.object({ caId: z.number().int(), instrumentId: z.number().int(),
  caType: z.enum(['cash_dividend','special_dividend','stock_dividend','split','reverse_split','spinoff','merger','tender','rights','call','conversion','name_change','ticker_change','delisting','capital_return']),
  status: z.enum(['estimated','announced','confirmed','paid','cancelled']),
  declaredDate: z.iso.date().nullable(), exDate: z.iso.date(), recordDate: z.iso.date().nullable(), payDate: z.iso.date().nullable(), effectiveDate: z.iso.date().nullable(),
  amount: z.number().nullable(), currency: z.string().length(3).nullable(), ratioNew: z.number().nullable(), ratioOld: z.number().nullable(),
  newInstrumentId: z.number().int().nullable(), frequency: z.string().nullable(), grossOrNet: z.enum(['gross','net']), details: z.record(z.string(), z.unknown()),
  sourceId: z.string(), reviewState: z.enum(['auto','queued','reviewed','rejected']), provIdx: z.number().int() });
```

### 5.2 Search and universe (`search.ts`, `universe.ts`) — TERM-02

The client ranks locally (core `UniverseIndex` over `/universe/snapshot`); the server is consulted only
for name queries ≥ 3 characters with no local hit, debounced 60 ms (ARCHITECTURE §5). Both use
`core/command/rank.ts`, so the ordering is identical.

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/search` | `SearchQuery` | `200 SearchResponse` (p95 < 80 ms local) | any |
| GET | `/universe/snapshot` | header `If-None-Match` | `200 UniverseSnapshot` (gzip, `ETag: "<version>"`, `Cache-Control: private, max-age=3600`) or `304` | any |

```ts
export const SearchQuery = z.object({
  q: z.string().min(1).max(80),
  limit: z.number().int().min(1).max(25).default(12),
  kinds: z.array(z.enum(['instrument','function','person','topic'])).optional(),
  panelSecurityId: z.number().int().optional(), panelFunction: z.string().optional(),   // TERM-03 context boosts
});
export const SearchHit = z.object({                       // = core/search/types.ts Candidate + display fields
  kind: z.enum(['instrument','function','person','topic']),
  id: z.string(),                                         // instrumentId | function code | personId | topic code
  primary: z.string(),                                    // 'AAPL US Equity' | 'GP' | 'Jane Doe (Demo Desk)' | 'MARKETS'
  secondary: z.string(),                                  // 'Apple Inc · Common Stock · US' | 'Price graph'
  assetClass: AssetClass.optional(), marketSector: MarketSector.optional(),
  score: z.number(),
  matchedOn: z.enum(['code','ticker','name','isin','cusip','figi','alias','trigram']),
  matched: z.array(z.tuple([z.number().int(), z.number().int()])),   // highlight ranges in `primary`
  insertText: z.string(),                                 // what GO executes: 'AAPL US Equity' | 'GP'
  source: z.enum(['local','yahoo']).default('local'),     // Yahoo fallback hits (≤ 8) are never auto-added to the master
});
export const SearchResponse = z.object({ hits: z.array(SearchHit), tookMs: z.number(), traceId: z.uuid() });

export const UniverseSnapshot = z.object({
  version: z.string(),                                    // sha1 of content = ETag
  generatedAt: z.iso.datetime(),
  instruments: z.array(z.tuple([
    z.number().int(),   // instrumentId
    z.string(),         // ticker
    MarketSector,
    z.string(),         // exchCode ('US','GOVT','INDEX','FX','RATE','ECON','CRYPTO')
    z.string(),         // name
    AssetClass,
    z.number(),         // searchWeight (instruments.search_weight)
    z.number().int(),   // status: 1 active, 0 otherwise
  ])),
  functions: z.array(z.tuple([z.string(), z.string(), z.array(z.string()), z.number().int()])),   // code, name, aliases, tier
  people:    z.array(z.tuple([z.number().int(), z.string(), z.string()])),                         // personId, name, role/firm
  topics:    z.array(z.tuple([z.string(), z.string()])),                                           // code, name
});
```

### 5.3 Functions (`functions.ts`) — FUNC-01, FUNC-02, FUNC-04

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/functions` | — | `200 { registryVersion, functions: FunctionManifestPublic[] }` (ETag) | any |
| GET | `/functions/:code` | — | `200 FunctionManifestPublic` (aliases resolve: `IB` → `MSG`) | any |
| GET | `/functions/:code/help` | `assetClass?` | `200 HelpResponse` (HELP ×1 content, TERM-09) | any |
| POST | `/functions/:code/run` | `FunctionRunRequest` | `200 Payload` | any |
| POST | `/functions/:code/page` | `{ resultId, direction: 'fwd'\|'back' }` | `200 Payload` (new `resultId`) | any |
| GET | `/results/:resultId` | — | `200 Payload` — the cached result (10 min TTL); when the viewer is not the producer the server re-runs at the cached `meta.asOf` under the **viewer's** entitlements (MSG-04 share links) | any |

```ts
export const FunctionManifestPublic = z.object({          // FunctionManifest minus code (ARCHITECTURE §5.2)
  code: z.string(), name: z.string(), aliases: z.array(z.string()), tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  category: z.enum(['reference','pricing','charting','news','fundamentals','screening','rates','derivatives','portfolio','messaging','monitor','system']),
  assetClasses: z.union([z.array(AssetClass), z.literal('any'), z.literal('none')]),
  requiresSecurity: z.boolean(), pageable: z.boolean(), screenKind: z.enum(['declarative','custom']),
  paramsSchema: z.record(z.string(), z.unknown()),        // z.toJSONSchema(manifest.params)
  paramGrammar: z.record(z.string(), z.unknown()),        // ParamGrammar
  fieldIds: z.record(z.string(), z.array(FieldId)),       // per asset class ('*' for none)
  csvColumns: z.array(z.object({ id: z.string(), label: z.string(), type: z.enum(['string','number','date','datetime','boolean']), decimals: z.number().int().optional() })).nullable(),  // null when columns depend on payload
  help: z.object({ summary: z.string(), description: z.string(), params: z.array(z.object({ name: z.string(), text: z.string(), example: z.string().optional() })),
                   keys: z.array(z.object({ key: z.string(), action: z.string() })), sources: z.array(z.string()), related: z.array(z.string()) }),
  keymap: z.array(z.object({ key: z.string(), action: z.string(), when: z.enum(['grid','chart','form','always']).optional(), description: z.string() })),
});
export const FunctionRunRequest = z.object({
  security: SecurityRefInput.optional(),                  // required when manifest.requiresSecurity → else 422 NO_SECURITY_CONTEXT
  params: z.record(z.string(), z.unknown()).default({}),  // validated by manifest.params → 400 VALIDATION_FAILED location 'fnParams'
  asOf: AsOf.optional(),
  panelId: z.string().max(16).optional(),                 // 'p1'..'p4' for usage_events.panel_id
  launchKind: z.enum(['launch','param','refresh']).default('launch'),   // → usage_events.kind fn.launch | fn.param (FUNC-04)
});
export const Payload = z.object({ data: z.unknown(), meta: PayloadMeta });   // data shape per FUNCTIONS.md <CODE>; data.variant discriminates the screen (FUNC-02)
export const HelpResponse = z.object({ code: z.string(), name: z.string(), summary: z.string(), description: z.string(),
  params: z.array(z.object({ name: z.string(), text: z.string(), example: z.string().optional() })),
  keys: z.array(z.object({ key: z.string(), action: z.string() })),
  fields: z.array(z.object({ id: FieldId, label: z.string(), definition: z.string(), sourceId: z.string(), attribution: z.string() })),   // fields the screen shows, from the dictionary (API-07)
  sources: z.array(z.string()), related: z.array(z.string()) });
```

Run semantics (ARCHITECTURE §5): parse → resolve security as-of → `422 FUNCTION_NOT_APPLICABLE` unless
`manifest.assetClasses` covers the instrument's class → `evaluate()` over `manifest.fieldIds(assetClass)`
with `usage:'display'` (or `'api'` for bearer) and `purpose=code` → resolver → `meta` stamped →
`resultCache.put(resultId)` → one `usage_events` row (`fn.launch`/`fn.param`/`fn.page`) and the
access-log rows. Reproducibility: the same `code`, `params` and explicit `asOf` return byte-identical
`data` and `meta.engines` regardless of wall-clock time (ANAL-08); only `traceId`, `resultId`,
`servedAt`, `staleness` and live-subject `provenance[].capturedAt` may differ. The live subjects a
screen opens are computed client-side by `manifest.live(params, payload)` from the SDK registry — the
payload does not carry them.

### 5.4 Data (`data.ts`) — API-02, DATA-07, ANAL-02

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| POST | `/data` | `DataRequest` (§4) | `200 DataResponse` | any |
| GET | `/data/reference` | `securities` (comma-separated refs), `fields`, `validAt?`, `knownAt?` | = `kind:'reference'` | any |
| GET | `/data/history` | `security`, `fields?`, `start`, `end?`, `periodicity?`, `adjust?`, `currency?`, `fill?`, `validAt?`, `knownAt?` | = `kind:'historical'` (single security) | any |
| GET | `/data/intraday` | `security`, `fields?`, `start`, `end?`, `interval?`, `session?` | = `kind:'intraday'` | any |
| GET | `/data/ticks` | `security`, `start`, `end`, `kinds?`, `limit?`, `cursor?` | = `kind:'tick'` | any |
| GET | `/data/snapshot` | `securities`, `fields`, `tier?` | = `kind:'realtime'` | any |
| GET | `/curves/:curveId` | `date?` (default latest), `validAt?`, `knownAt?`, `build?` (bool) | `200 { meta, curve: { curveId, name, currency, kind, dayCount, compounding, sourceId }, curveDate, points: [{ tenor, tenorDays, quoteType, value, instrumentId, maturityDate, provIdx }], build?: { buildId, method, interpolation, engine: EngineNote, nodes: [{ t, df, zero, fwd }] } }` (`UST_PAR`, `UST_BILL`, `UST_CMT`, `SOFR_FIX`, `SOFR_OIS`; CRVF/ICVS/GC) | any |
| GET | `/curves/:curveId/history` | `tenor`, `from`, `to`, `quoteType?` | `200 { meta, series: SeriesBlock }` | any |
| GET | `/rates/:rateCode` | `from?`, `to?`, `vintages?` (bool) | `200 { meta, fixings: [{ effectiveDate, vintageAt, rate, pct1, pct25, pct75, pct99, volumeBn, targetFrom, targetTo, avg30d, avg90d, avg180d, indexValue, revisionIndicator, isLatest, provIdx }] }` (BTMM, FED) | any |
| GET | `/econ/series/:seriesCode` | `from?`, `to?`, `vintage: 'latest'\|'all'\|'asOf'` (default latest), `knownAt?` | `200 { meta, series: { seriesId, code, name, sourceId, unit, frequency, seasonalAdj }, observations: [{ obsDate, value, status, vintageAt, isLatest, provIdx }] }` (ECO, GP on econ) | any |
| GET | `/econ/calendar` | `from`, `to`, `country?`, `releaseId?` | `200 { meta, events: [{ eventId, releaseId, releaseName, scheduledAt, timeKnown, periodLabel, seriesCode, actual, prior, revisedPrior, consensus: null, consensusUnavailableReason, status, provIdx }] }` (ECO; `consensus` is always null with reason `NO_SOURCE`, BRIEF §2) | any |
| GET | `/econ/fomc` | `from?`, `to?` | `200 { meetings: [{ meetingDate, statementAt, hasSep, decisionBp }] }` (WIRP nodes) | any |
| GET | `/options/chain` | `underlying` (ref or id), `expiry?`, `strikeMin?`, `strikeMax?`, `putCall?` | `200 { meta, underlying: InstrumentSummary, underlyingPx, expiries: string[], contracts: [{ instrument: InstrumentSummary, terms: OptionTerms, f: Record<FieldId, FieldValue>, r?, st, ts }] }` (OMON; fields `OPT_*`, `PX_BID/ASK`, `OPT_OI`) | any |
| GET | `/holders/:instrumentId` | `asOfDate?` | `200 { meta, holders: [{ holderName, holderKind:'etf'\|'13f', instrumentId?, shares, marketValue, weight, asOfDate, sourceId, provIdx }] }` (HDS: ETF holders from `etf_holdings`; 13F where feasible) | any |
| GET | `/short-interest/:instrumentId` | `from?`, `to?` | `200 { meta, rows: [{ settlementDate, shortInterest, avgDailyVolume, daysToCover, provIdx }] }` | any |

### 5.5 Fields (`fields.ts`) — API-07

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/fields` | `fieldClass?`, `assetClass?`, `q?` (substring on id/label), `version?` (dictionary version; current when omitted) | `200 FieldDictionary` (§7) with `ETag` | any (*public* when `PUBLIC_FIELDS=1`) |
| GET | `/fields/:id` | — | `200 FieldDef & { licence: LicenceSummary }` — the governing `licence_registry` row per asset class (attribution, display/export/api flags, `maxTier`, `retentionDays`) | any |
| GET | `/fields/changelog` | `since?` (version) | `200 { versions: [{ version, date, added: FieldId[], deprecated: [{ id, replacement, removeAfter }], removed: FieldId[], changed: [{ id, what }] }] }` | any |

### 5.6 News (`news.ts`) — NEWS-01, NEWS-02, NEWS-07, NEWS-08

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/news` | `NewsQuery` | `200 { meta, items: NewsItem[], nextCursor }` — `q` uses `websearch_to_tsquery` on `news_items.tsv` with trigram fallback on `headline`; newest first (N) | any |
| GET | `/news/top` | `scope: 'all'\|'instrument'\|'topic'\|'feed'`, `id?`, `limit≤50` | `200 { meta, items: NewsItem[] }` ranked by `news/ranker.ts` (recency × feed weight × link confidence × click-through) (TOP) | any |
| GET | `/news/:newsId` | — | `200 NewsItem & { links: NewsLink[] }` | any |
| GET | `/topics` | — | `200 { topics: [{ topicId, code, name, kind, parentCode }] }` | any |

```ts
export const NewsQuery = z.object({
  q: z.string().max(200).optional(), instrumentId: z.number().int().optional(), issuerId: z.number().int().optional(),
  topic: z.string().optional(), feed: z.string().optional(), kinds: z.array(z.enum(['story','video','filing','press_release','fed_release'])).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).default(50),
});
export const NewsItem = z.object({
  newsId: z.number().int(), sourceId: z.string(), feed: z.string(), kind: z.enum(['story','video','filing','press_release','fed_release']),
  headline: z.string(), summary: z.string().nullable(), url: z.string(), author: z.string().nullable(), category: z.string().nullable(),
  cik: z.string().nullable(), items8k: z.array(z.string()).nullable(), lang: z.string(),
  publishedAt: z.iso.datetime(), capturedAt: z.iso.datetime(), isCorrection: z.boolean(),
  machineGenerated: z.boolean(),                          // NEWS-08: always false in v1; the client renders true in a separate hierarchy
  provIdx: z.number().int(),
  links: z.array(z.object({ entityKind: z.enum(['instrument','issuer','person','topic']), entityId: z.number().int(), display: z.string(),
                            confidence: z.number(), method: z.enum(['cik','ticker_exact','name_exact','name_alias','feed_topic','keyword','manual']) })).optional(),
});
```

Bodies are never stored or served for Bloomberg RSS (link-out only, DATA_MODEL §10); `summary` is the
feed description with HTML stripped.

### 5.7 Workspace and annotations (`workspaces.ts`) — TERM-04, TERM-05, TERM-10, CHRT-05

```ts
export const Frame = z.object({
  security: z.object({ id: z.number().int(), display: z.string() }).nullable(),   // resolved instrument (never a bare ticker, REF-01)
  fn: z.string().nullable(),                              // function code
  params: z.record(z.string(), z.unknown()).default({}),
  resultId: z.string().nullable().default(null),          // last result (stale-while-revalidate hint; may be expired)
  scroll: z.number().int().default(0),
});
export const PanelState = z.object({
  id: z.string().regex(/^p[1-8]$/),
  frameStack: z.array(Frame).max(50), index: z.number().int().min(0),     // back-stack + position (PAGE BACK/FWD)
  history: z.array(z.string()).max(100),                  // command-line history
  commandDraft: z.string().max(200).default(''),
});
export const MonitorSpec = z.object({ id: z.string(), title: z.string(), watchlistId: z.number().int().nullable(), columns: z.array(z.string()),
  sort: z.object({ col: z.string(), dir: z.enum(['asc','desc']) }).nullable(), groupBy: z.string().nullable() });
export const WorkspaceLayout = z.object({
  schema: z.literal(1),                                   // layout schema version (migrated client-side on load)
  mode: z.enum(['1','2h','2v','4']),
  panels: z.array(PanelState).min(1).max(8),
  focus: z.string(),                                      // panel id
  monitors: z.array(MonitorSpec).default([]),
  chart: z.object({ defaultRange: z.string().default('1Y'), defaultType: z.string().default('line'), studies: z.array(z.string()).default([]) }).default({}),
  conflationMs: z.number().int().min(50).max(5000).default(250),
  windows: z.array(z.object({ windowId: z.string(), screen: z.string(), bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]), panelIds: z.array(z.string()) })).default([]),   // TERM-10 shape
});
export const Workspace = z.object({ workspaceId: z.number().int(), name: z.string(), isActive: z.boolean(), version: z.number().int(), layout: WorkspaceLayout, updatedAt: z.iso.datetime() });
export const ChartAnnotation = z.object({ annotationId: z.number().int(), instrumentId: z.number().int(), ownerUserId: z.number().int(),
  kind: z.enum(['trendline','hline','vline','fib','text','regression_channel','rect']),
  anchors: z.array(z.object({ t: z.number(), v: z.number() })), style: z.record(z.string(), z.unknown()), label: z.string().nullable(),
  sharedScope: z.enum(['private','firm','users']), sharedUserIds: z.array(z.number().int()), updatedAt: z.iso.datetime() });
```

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/workspace` | — | `200 Workspace` (the active one; created from `fixtures/seed/workspaces.json` default on first login) | any |
| PUT | `/workspace` | `{ version: number, layout: WorkspaceLayout }` | `200 { version, updatedAt }`; `409 WORKSPACE_VERSION_CONFLICT` with `details.current` — client merges (last-writer-wins per panel) and retries; autosave debounced 2 s | any |
| GET | `/workspaces` | — | `200 { items: Workspace[] }` (layouts omitted) | any |
| POST | `/workspaces` | `{ name, layout }` | `201 Workspace`; `409 DUPLICATE_NAME` | any |
| GET / PUT / DELETE | `/workspaces/:workspaceId` | PUT `{ version, name?, layout? }` | `200 Workspace` / `204` | any |
| POST | `/workspaces/:workspaceId/activate` | — | `200 Workspace` (flips `is_active`) | any |
| GET | `/annotations` | `instrumentId` | `200 { items: ChartAnnotation[] }` (own + shared-with-me + firm) | any |
| POST / PUT / DELETE | `/annotations`, `/annotations/:annotationId` | `ChartAnnotation` minus ids | `201`/`200 ChartAnnotation` / `204` | any |

### 5.8 Watchlists (`watchlists.ts`) — W, CHRT-07

```ts
export const WatchlistColumn = z.union([
  z.object({ id: FieldId, label: z.string().optional(), decimals: z.number().int().optional() }),
  z.object({ id: z.string().regex(/^c[0-9]+$/), formula: z.string().max(400), label: z.string(), decimals: z.number().int().optional() }),   // core/formula over row fields
]);
export const WatchlistItemInput = z.union([
  z.object({ security: SecurityRefInput, label: z.string().optional(), note: z.string().max(500).optional() }),
  z.object({ formula: z.string().max(400), label: z.string(), note: z.string().max(500).optional() }),
]);
export const Watchlist = z.object({ watchlistId: z.number().int(), ownerUserId: z.number().int(), name: z.string(), columns: z.array(WatchlistColumn),
  sort: z.array(z.object({ col: z.string(), dir: z.enum(['asc','desc']) })), groupBy: z.string().nullable(),
  sharedScope: z.enum(['private','firm','users']), sharedUserIds: z.array(z.number().int()), updatedAt: z.iso.datetime(),
  items: z.array(z.object({ position: z.number().int(), instrument: InstrumentSummary.nullable(), formula: z.string().nullable(), label: z.string().nullable(), note: z.string().nullable(), addedAt: z.iso.datetime() })).optional() });
```

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/watchlists` | — | `200 { items: Watchlist[] }` (items omitted; own + shared) | any |
| POST | `/watchlists` | `{ name, columns, sort?, groupBy?, sharedScope?, sharedUserIds?, items?: WatchlistItemInput[] }` | `201 Watchlist` | any |
| GET / PUT / DELETE | `/watchlists/:watchlistId` | PUT same as POST minus items | `200 Watchlist` (with items) / `204` | owner (PUT/DELETE); any reader (GET) |
| PUT | `/watchlists/:watchlistId/items` | `{ items: WatchlistItemInput[] }` (full replace, ≤ 2 000) | `200 Watchlist` | owner |
| GET | `/watchlists/:watchlistId/export.csv` | — | `text/csv` (§9) | any reader |

Watchlist members of connected users join the plant hot set (ARCHITECTURE §6.2).

### 5.9 Portfolios (`portfolios.ts`) — PORT-01, PORT-02, PORT-07

Every table is RLS-isolated by `firm_id` (DATA_MODEL §15); a portfolio of another firm is `404`.

```ts
export const PositionInput = z.object({ identifier: z.string(), quantity: z.number(), costPrice: z.number().optional(), costCurrency: z.string().length(3).optional(),
  lotId: z.string().default('default'), tradeDate: z.iso.date().optional(), settleDate: z.iso.date().optional(), isCash: z.boolean().default(false), cashCurrency: z.string().length(3).optional() });
export const Position = PositionInput.extend({ positionId: z.number().int(), asOfDate: z.iso.date(), instrument: InstrumentSummary.nullable(),
  accrued: z.number(), reconStatus: z.enum(['ok','unresolved','duplicate','price_missing']), importId: z.number().int().nullable() });
export const ImportReport = z.object({ importId: z.number().int(), channel: z.enum(['upload','file_drop','api','manual']), asOfDate: z.iso.date(), status: z.enum(['accepted','partial','rejected']),
  rowsTotal: z.number().int(), rowsOk: z.number().int(), rowsError: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), identifier: z.string(), column: z.string(), reason: z.string() })),
  reconciliation: z.object({ matched: z.number().int(), added: z.number().int(), removed: z.number().int(),
                             quantityDiffs: z.array(z.object({ instrumentId: z.number().int(), before: z.number(), after: z.number() })) }) });
```

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET / POST | `/portfolios` | POST `{ name, baseCurrency?, benchmark?: SecurityRefInput }` | `200 { items }` / `201 { portfolioId, name, baseCurrency, benchmark: InstrumentSummary \| null }` | any |
| GET / PUT / DELETE | `/portfolios/:portfolioId` | | | owner or firm admin |
| GET | `/portfolios/:portfolioId/positions` | `asOfDate?` | `200 { meta, asOfDate, positions: Position[] }` | firm |
| PUT | `/portfolios/:portfolioId/positions` | `{ asOfDate, positions: PositionInput[] }` (API channel, full replace for that date) | `200 ImportReport` | owner |
| POST | `/portfolios/:portfolioId/import` | `multipart/form-data`: `file` (CSV `identifier,quantity,cost_price,cost_currency,lot_id,trade_date`), `asOfDate` | `200 ImportReport` (PORT-01 reconciliation) | owner |
| GET | `/portfolios/:portfolioId/imports` | `limit?` | `200 { items: ImportReport[] }` | firm |
| GET | `/portfolios/:portfolioId/lots` | `open?` | `200 { items: [{ lotId, instrument, openDate, quantity, unitCost, currency, closedDate, externalRef }] }` | firm |
| POST | `/portfolios/:portfolioId/analytics` | `{ asOf?: AsOf, benchmark?: SecurityRefInput, scenarios?: ScenarioSpec[] }` | `200 Payload` — **the same resolver as function `PORT`** (single implementation) | firm |

### 5.10 Messaging (`messages.ts`) — MSG-01, MSG-02, MSG-03, MSG-04, MSG-06

```ts
export const Attachment = z.discriminatedUnion('kind', [                      // MSG-04: rendered live in the recipient's client within THEIR entitlements
  z.object({ kind: z.literal('security'),  instrumentId: z.number().int() }),
  z.object({ kind: z.literal('function'),  code: z.string(), instrumentId: z.number().int().nullable(), params: z.record(z.string(), z.unknown()), resultId: z.string().optional() }),
  z.object({ kind: z.literal('chart'),     instrumentId: z.number().int(), params: z.record(z.string(), z.unknown()), annotationIds: z.array(z.number().int()).default([]) }),
  z.object({ kind: z.literal('portfolio'), portfolioId: z.number().int() }),
  z.object({ kind: z.literal('watchlist'), watchlistId: z.number().int() }),
]);
export const StructuredMsg = z.object({ type: z.enum(['ioi','rfq']), side: z.enum(['buy','sell']), instrumentId: z.number().int(), qty: z.number(), price: z.number().nullable() });   // MSG-06 display only
export const Message = z.object({ messageId: z.number().int(), roomId: z.number().int(), seq: z.number().int(), senderUserId: z.number().int(), senderFirmId: z.number().int(),
  senderDisplay: z.string(), sentAt: z.iso.datetime(), body: z.string(), attachments: z.array(Attachment), structured: StructuredMsg.nullable(),
  clientMsgId: z.uuid(), prevHash: z.string().nullable(), hash: z.string() /* sha256 hex */, traceId: z.uuid().nullable() });
export const Room = z.object({ roomId: z.number().int(), kind: z.enum(['dm','group','firm','helpdesk']), name: z.string().nullable(), scope: z.enum(['internal','external']),
  disclaimer: z.string().nullable(), wallTag: z.string().nullable(), createdAt: z.iso.datetime(),
  members: z.array(z.object({ userId: z.number().int(), displayName: z.string(), firmName: z.string(), desk: z.string().nullable(), role: z.enum(['member','owner','supervisor']) })),
  lastSeq: z.number().int(), lastReadSeq: z.number().int(), lastMessageAt: z.iso.datetime().nullable() });
export const DirectoryEntry = z.object({ userId: z.number().int(), displayName: z.string(), firmId: z.number().int(), firmName: z.string(), desk: z.string().nullable(), role: Role, verified: z.boolean() });
```

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/rooms` | — | `200 { items: Room[] }` (rooms the caller is a member of; RLS via `is_room_member()`) | any |
| POST | `/rooms` | `{ kind: 'dm'\|'group', name?, memberUserIds: number[] }` | `201 Room`; `403 MESSAGE_POLICY_BLOCKED` (counterparty firm not permitted, ethical wall, external) | any |
| GET | `/rooms/:roomId` | — | `200 Room` | member |
| POST / DELETE | `/rooms/:roomId/members` | `{ userIds }` | `200 Room` | owner/supervisor |
| GET | `/rooms/:roomId/messages` | `before?` (seq), `after?` (seq), `limit≤200` | `200 { items: Message[], nextCursor }` in `seq` order | member |
| POST | `/rooms/:roomId/messages` | `{ clientMsgId: uuid, body: string.max(8000), attachments?: Attachment[], structured?: StructuredMsg }` | `201 Message` (idempotent on `clientMsgId`: a repeat returns the stored row, `200`); hash chain assigned by the DB trigger; lexicon surveillance runs async | member |
| POST | `/rooms/:roomId/read` | `{ lastReadSeq }` | `204` | member |
| GET | `/directory` | `q`, `limit≤25` | `200 { items: DirectoryEntry[] }` (verified users, firms, desks — MSG-01) | any |

Messages are immutable: no PUT/DELETE exists; corrections are new messages. Live delivery is the WS
`room:<roomId>` subject (§6.9).

### 5.11 Alerts and saved searches (`alerts.ts`) — NEWS-07

```ts
export const AlertCondition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('price'),    security: SecurityRefInput, field: FieldId.default('PX_LAST'), op: z.enum(['>=','<=','crosses']), value: z.number() }),
  z.object({ kind: z.literal('news'),     savedSearchId: z.number().int().optional(), query: NewsQuery.pick({ q: true, instrumentId: true, topic: true, feed: true }).optional() }),
  z.object({ kind: z.literal('filing'),   ciks: z.array(z.string()).optional(), instrumentIds: z.array(z.number().int()).optional(), forms: z.array(z.string()).default(['8-K']), items: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('calendar'), releaseId: z.number().int(), minutesBefore: z.number().int().min(0).max(1440).default(15) }),
]);
export const Alert = z.object({ alertId: z.number().int(), condition: AlertCondition, delivery: z.array(z.enum(['inapp','email','push'])), status: z.enum(['armed','paused','fired','deleted']),
  oneShot: z.boolean(), createdAt: z.iso.datetime(), lastFiredAt: z.iso.datetime().nullable() });
export const AlertEvent = z.object({ eventId: z.number().int(), alertId: z.number().int(), firedAt: z.iso.datetime(),
  payload: z.object({ value: z.number().optional(), newsId: z.number().int().optional(), accessionNo: z.string().optional(), eventId: z.number().int().optional(), provenanceId: z.number().int().optional(), summary: z.string() }),
  delivered: z.record(z.string(), z.iso.datetime().nullable()), acknowledgedAt: z.iso.datetime().nullable() });
```

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET / POST | `/alerts` | POST `{ condition, delivery?, oneShot? }` | `200 { items: Alert[] }` / `201 Alert` | any |
| GET / PUT / DELETE | `/alerts/:alertId` | PUT `{ condition?, delivery?, status?: 'armed'\|'paused' }` | `200 Alert` / `204` (status → deleted) | owner |
| GET | `/alerts/events` | `since?`, `limit≤200` | `200 { items: AlertEvent[] }` (in-app delivery record; email/push are recorded intents in v1) | any |
| POST | `/alerts/events/:eventId/ack` | — | `204` | owner |
| GET / POST / DELETE | `/saved-searches`, `/saved-searches/:searchId` | `{ kind: 'news'\|'eqs'\|'srch', name, query }` | `SavedSearch` | any |

Fired alerts stream on the WS `alerts:me` subject as `alert` messages (§6.9).

### 5.12 Help (`help.ts`) — TERM-09

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/help/:code` | `assetClass?` | `200 HelpResponse` (same as `/functions/:code/help`; HELP ×1) | any |
| POST | `/help/tickets` | `{ panelId?, functionCode?, security?: SecurityRefInput, params?, screenState: object /* visible fields + provenance idx */, traceId?: uuid, question: string.min(1).max(4000) }` | `201 { ticketId, roomId }` — HELP ×2 creates a `help_tickets` row and a `helpdesk` room with the `helpdesk` role users; `usage_events kind='ticket.open'` | any |
| GET | `/help/tickets` | `status?` | `200 { items: [{ ticketId, openedAt, functionCode, question, status, roomId, answer, answeredAt }] }` (own; `helpdesk` role sees all) | any |

### 5.13 Usage, quotas and entitlements (`usage.ts`) — FUNC-04, API-06, ENTL-05

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| POST | `/usage/events` | `{ events: z.array(UsageEvent).max(100) }` — client-side events batched every 5 s | `202` | any |
| GET | `/usage/quota` | — | `200 { dailyUniqueInstruments: QuotaUsage, monthlyDataPoints: QuotaUsage, concurrentSubscriptions: QuotaUsage, enforced: boolean /* true for api sessions */ }` | any |
| GET | `/usage/entitlements` | — | `200 { defaultTier, grants: [{ subjectKind, sourceId, assetClass, fieldClass, maxTier, usageDisplay, usageExport, usageApi, validFrom, validTo }], licences: LicenceSummary[] }` (what the evaluator will decide, so a screen can pre-label) | any |
| GET | `/usage/functions` | `days≤365` | `200 { items: [{ code, launches, users, exports }] }` (the roadmap query, ARCHITECTURE §11) | admin, dataops |

```ts
export const UsageEvent = z.object({
  ts: z.iso.datetime(),
  kind: z.enum(['fn.launch','fn.param','fn.page','fn.export','fn.help','search.select','cmd.parse_error','panel.switch','ws.subscribe','ws.slow','ws.resync','ticket.open']),
  panelId: z.string().optional(), code: z.string().optional(), paramsHash: z.string().length(64).optional(), instrumentId: z.number().int().optional(),
  durationMs: z.number().int().optional(), traceId: z.uuid().optional(), details: z.record(z.string(), z.unknown()).default({}),
});
```

Server-originated kinds (`fn.launch`, `fn.param`, `fn.page`, `fn.export`, `ws.*`) are written by the
server; a client posting them is accepted but flagged `details.clientReported=true`.

### 5.14 Admin and compliance (`admin.ts`) — OPS-07, ENTL-06, DATA-02, DATA-09, REF-10, REG-01, REG-04, MSG-02

| Method | Path | Request | Response | Role |
| --- | --- | --- | --- | --- |
| GET | `/admin/trace/:traceId` | — | `200 { traceId, requests: [{ ts, route, status, latencyMs, userId }], accessLog: [...], usageEvents: [...], provenance: [ProvenanceRef & { requestUrl, httpStatus, fixtureFile? }], ingestRuns: [...], messages: [...], tickets: [...] }` — one string to the raw recorded response (OPS-07) | admin, dataops, helpdesk |
| GET | `/admin/declarations` | `month=YYYY-MM`, `sourceId?`, `firmId?`, `format=json\|csv` | `200 { items: [{ month, sourceId, firmId, fieldClass, tier, displayUsers, exportUsers, apiUsers, distinctUsers, instrumentCount, dataPoints, seatCount, generatedAt, reconciledAt, billingRef }] }` (ENTL-06, DATA-02) | admin, compliance |
| POST | `/admin/declarations/generate` | `{ month }` | `202 { runId }` runs `entitlements/declarations.ts` and upserts `usage_declarations` | admin |
| POST | `/admin/declarations/:declarationId/reconcile` | `{ billingRef }` | `200` | admin, compliance |
| GET | `/admin/licences` | — | `200 { items: LicenceEntry[] }` (current `licence_registry` versions) | admin, dataops, compliance |
| PUT | `/admin/licences/:sourceId` | `LicenceEntry` minus keys + `validFrom` | `200 LicenceEntry` — writes a new bitemporal version via `writeVersion`; bumps `config_versions('entitlements')` | admin |
| GET / POST / DELETE | `/admin/entitlements`, `/admin/entitlements/:grantId` | `{ subjectKind, subjectId, sourceId?, assetClass?, fieldClass?, maxTier, usageDisplay?, usageExport?, usageApi?, validFrom?, validTo?, contractRef?, note? }` | `EntitlementGrant` | admin |
| GET | `/admin/access-log` | `from`, `to`, `userId?`, `instrumentId?`, `sourceId?`, `decision?`, `cursor?`, `limit≤1000` | `200 { items: AccessLogRow[], nextCursor }` (ENTL-04) | admin, compliance |
| GET | `/admin/access-log/export.csv` | same filters | `text/csv` | admin, compliance |
| GET | `/admin/exceptions` | `status?`, `kind?`, `assignee?` | `200 { items: DataException[] }` (REF-10 queue with `slaDueAt`) | dataops, admin |
| POST | `/admin/exceptions/:exceptionId/resolve` | `{ chosenProvenanceId?, note, action: 'accept'\|'reject' }` | `200 DataException` — accept writes the chosen candidate as a new bitemporal version (`reason:'correction'`) | dataops |
| GET | `/admin/ca-queue` | — | `200 { items: CorporateAction[] }` (`review_state='queued'`) | dataops |
| POST | `/admin/ca-queue/:caId/review` | `{ decision: 'reviewed'\|'rejected', note? }` | `200 CorporateAction` (DATA-08 dual key) | dataops |
| GET | `/admin/dq` | `open?`, `kind?`, `since?` | `200 { items: DqEvent[] }` (OPS-03) | admin, dataops |
| POST | `/admin/dq/:dqId/resolve` | — | `204` | dataops |
| GET | `/admin/ingest/runs` | `job?`, `limit≤200` | `200 { items: IngestRun[] }` | admin, dataops |
| POST | `/admin/ingest/run/:jobId` | — | `202 { runId }` (on-demand run; respects buckets and the leader lock) | admin, dataops |
| GET | `/admin/compliance/reviews` | `status?` | `200 { items: [{ reviewId, message: Message, flaggedBy, status, hits: [{ termId, pattern, matchedText }] }] }` (MSG-02) | compliance |
| POST | `/admin/compliance/reviews/:reviewId` | `{ status: 'reviewed'\|'escalated', note }` | `200` | compliance |
| GET / POST / DELETE | `/admin/compliance/holds`, `/admin/compliance/holds/:holdId` | `{ scope: { userIds?, roomIds?, from?, to? }, reason }` | `LegalHold` | compliance |
| GET | `/admin/export/messages` | `room?`, `userId?`, `from`, `to` | `application/x-ndjson`: one `Message` per line in `seq` order plus a final `{ "chain": "ok"\|"broken", "firstBadSeq"? }` line (REG-01 production on request) | compliance |
| GET | `/admin/users` · `POST /admin/users` · `PUT /admin/users/:userId` | `{ email, displayName, firmId, role, desk?, mfaRequired?, status? , password? }` | `User` (SEC-01 onboarding record; `person_verified_at` set by `POST /admin/users/:userId/verify`) | admin |
| DELETE | `/admin/users/:userId` | — | `204` — anonymises (`anonymised_at`, `user-<id>`), revokes sessions/keys, keeps `access_log` (REG-04) | admin |
| GET / POST | `/admin/incidents`, `/admin/incidents/:incidentId/updates` | `{ component, severity, title }` / `{ text, close? }` | `StatusIncident` (OPS-04) | admin |

### 5.15 Status, health, metrics (`status.ts`, `health.ts`) — OPS-04, OPS-03

| Method | Path | Response | Role |
| --- | --- | --- | --- |
| GET | `/health` | `200 { status: 'starting'\|'ok'\|'degraded', db: boolean, plant: boolean, scheduler: boolean, migrationsPending: number, uptimeS }` (`503 STARTING` until startup step 8) | *public* |
| GET | `/status` | `200 StatusResponse` | any (*public* summary when `PUBLIC_STATUS=1`) |
| GET | `/metrics` (root, not under `/api/v1`) | Prometheus text (ARCHITECTURE §11 metric names) | *public* on loopback; otherwise `Authorization: Bearer <METRICS_TOKEN>` |

```ts
export const StatusResponse = z.object({
  serverTime: z.iso.datetime(), serverVersion: z.string(), minClientVersion: z.string(), protocol: z.array(z.literal(1)), dictionaryVersion: z.string(), registryVersion: z.string(),
  providerMode: z.enum(['live','record','replay']),
  plant: z.object({ state: z.enum(['ok','degraded']), subjects: z.number().int(), hotSet: z.number().int(), applyP99Ms: z.number(), publishP99Ms: z.number(), conflationFloorMs: z.number().int() }),
  ws: z.object({ sessions: z.number().int(), subscriptions: z.number().int(), slowSessions: z.number().int() }),
  providers: z.array(z.object({ sourceId: z.string(), circuit: z.enum(['closed','open','half_open']), lastOkAt: z.iso.datetime().nullable(), lastErrorAt: z.iso.datetime().nullable(), p95Ms: z.number().nullable(), bucketRemaining: z.number() })),
  sessions: z.array(z.object({ calendarId: z.string(), state: SessionState, nextChangeAt: z.iso.datetime().nullable() })),   // 'NYSE', 'SIFMA', 'FX'
  scheduler: z.object({ leader: z.boolean(), lagMs: z.number(), running: z.array(z.string()), lastFailures: z.array(z.object({ jobId: z.string(), at: z.iso.datetime(), code: z.string() })) }),
  dq: z.object({ open: z.number().int(), byKind: z.record(z.string(), z.number().int()) }),
  incidents: z.array(z.object({ incidentId: z.number().int(), component: z.string(), severity: z.enum(['info','degraded','outage']), title: z.string(), openedAt: z.iso.datetime(), updates: z.array(z.object({ ts: z.iso.datetime(), text: z.string() })) })),
  timings: z.object({ autocompleteP95Ms: z.number(), fnLaunchP95Ms: z.record(z.string(), z.number()), historyP95Ms: z.number() }),   // read by the Playwright budgets
});
```

---
## 6. WebSocket protocol — `/ws/v1`, `wire/ws.ts` (BUS-01..08, ENTL-05, TERM-12)

Text frames, one JSON object per frame; server→client deltas are grouped in `batch` frames. Timestamps
are epoch milliseconds. The schemas below are those of ARCHITECTURE §6.4 and are normative; the server
side is `packages/server/src/ws/{gateway,session,conflator,protocol}.ts`, the client side
`packages/sdk/src/client/ws.ts`.

### 6.1 Subject grammar (BUS-02) — `plant/subjects.ts`, regex `SubjectId` (§3)

| Subject | Meaning | Fields (`f`) — dictionary ids unless noted | Snapshot | Delta semantics |
| --- | --- | --- | --- | --- |
| `q:<instrumentId>` | composite quote for any instrument (equity, etf, index, fx, govt, option contract, crypto, rate) | `QuoteFields`: `PX_LAST LAST_SIZE LAST_TRADE_TIME PX_BID PX_ASK BID_SIZE ASK_SIZE PX_OPEN PX_HIGH PX_LOW PX_CLOSE_1D PX_OFFICIAL_CLOSE PX_VOLUME VWAP CHG_NET_1D CHG_PCT_1D TICK_DIR IVOL_30D SESSION_STATE`; options add `OPT_IV OPT_DELTA OPT_GAMMA OPT_VEGA OPT_THETA OPT_RHO OPT_OI OPT_THEO OPT_UNDL_PX`; rates add `RATE RATE_P1 RATE_P25 RATE_P75 RATE_P99 RATE_VOLUME_BN TARGET_FROM TARGET_TO` | full subscribed set | conflated (§6.4) |
| `l:<mdLineId>` | one market-data line (per-source view for QM) | same as `q:` | full | conflated |
| `b1m:<instrumentId>` | forming 1-minute bar | `BAR_TS PX_OPEN PX_HIGH PX_LOW PX_LAST PX_VOLUME IS_FINAL` | current bar | conflated; `IS_FINAL=true` delta closes the bar, next delta opens a new `BAR_TS` |
| `oc:<instrumentId>` | option-chain summary for an underlying (contracts themselves are `q:`) | `EXPIRIES` (comma-separated ISO dates, string) `ATM_IV PUT_CALL_RATIO CONTRACT_COUNT UNDL_PX` | full | conflated |
| `c:<curveId>` | curve as last built (`c:UST_PAR`, `c:SOFR_OIS`) | `TENORS` (comma string) `RATES` (comma string, percent) `BUILD_ID BUILD_TS CURVE_DATE` | latest build | one delta per rebuild |
| `r:<rateCode>` | alias of `q:` for a rate instrument (`r:SOFR`) | rate fields | full | conflated |
| `e:<seriesCode>` | econ series latest observation / release (`e:CPIAUCSL`) | `VALUE PERIOD RELEASED_AT PREV REVISED STATUS` | latest | one delta per release/vintage |
| `n:<scope>` | headline stream: `n:all`, `n:feed:markets`, `n:inst:<instrumentId>`, `n:topic:<code>` | `NEWS_ID HEADLINE PUBLISHED_AT SOURCE_ID LINK KIND IS_CORRECTION` | most recent headline | **not conflated**: one delta per headline, in `publishedAt` order (a headline is never overwritten by a later one) |
| `alerts:me` | fired alerts for the session user | — | none | `alert` messages |
| `room:<roomId>` | chat room stream | — | none | `msg` messages |
| `sys:status` | provider health, plant degraded flag, market sessions, server clock | `PLANT_STATE CONFLATION_FLOOR_MS PROVIDERS_DOWN` (comma string) `SESSION_NYSE SESSION_SIFMA SESSION_FX SERVER_TIME OPEN_INCIDENTS MIN_CLIENT_VERSION` | full | one delta per change |

`f: []` on `sub` means "all fields of the subject" and is only accepted for `c:`, `e:`, `n:`, `sys:`,
`alerts:` and `room:`; quote-family subjects must name fields (a client subscribing to `PX_LAST` never
receives `PX_BID`, BUS-02). Field masks are bitsets over the dictionary index (ARCHITECTURE §6.2).
`n:*`, `c:*`, `e:*`, `sys:*` fields are dictionary entries with `fieldClass` `news`/`analytic`/`econ`/`derived`
and `assetClasses: []` so `FIELD_UNKNOWN` applies uniformly.

### 6.2 Messages — `wire/ws.ts` (verbatim from ARCHITECTURE §6.4)

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

const Ts   = z.object({ src: z.number().nullable(), cap: z.number(), pub: z.number() });             // FEED-05 three timestamps, epoch ms
const Prov = z.object({ p: z.string(), id: z.number(), seq: z.number().optional() });                // sourceId, provenanceId, provider seq (Cboe seqno)
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
  z.object({ t: z.literal('alert'), alertId: z.string(), firedAt: z.number(), payload: z.unknown() }),   // payload = Rest AlertEvent (§5.11)
  z.object({ t: z.literal('msg'), room: z.string(), message: z.unknown() }),                            // message = Rest Message (§5.10)
  z.object({ t: z.literal('err'), code: z.string(), message: z.string(), traceId: z.string(), fatal: z.boolean() }),
  z.object({ t: z.literal('pong'), n: z.number().int(), serverTime: z.number() }),
  z.object({ t: z.literal('bye'), code: z.number().int(), reason: z.string() }),
]);
```

`z.record(FieldId, …)` is a partial record (zod 4 treats a pattern-string key as non-exhaustive). The
`alert` and `msg` payloads are validated by the SDK with `Rest.Alerts.AlertEvent` and
`Rest.Messages.Message` respectively.

### 6.3 Handshake, sequencing and the snapshot-then-delta guarantee (BUS-01, BUS-07)

1. Client opens `/ws/v1` (cookie on the upgrade, or bearer via `hello.token`) and sends `hello` within
   5 s. Server answers `welcome` (`heartbeatMs=15000`, `limits.maxSubscriptions` = 10 000 for web
   sessions / 2 000 for API sessions, `limits.maxFields=100`, `conflationMs` = the granted value). A second
   socket for the same session replaces the first, which is closed `4003 SESSION_SUPERSEDED` (reason
   `'ws-replaced'`); four panels share one socket (TERM-04).
2. `sub` → the evaluator runs per subject × field × requested tier with `usage:'display'`
   (`'api'` for bearer), `purpose:'ws.sub'`; every decision is access-logged (ENTL-01/04). Reply order:
   `subAck`, then **exactly one `snap` per accepted subject** (inside `batch` frames), then `delta`s.
   A `snap` carries the full subscribed field set for the granted tier; unavailable fields are `null`
   with a reason in `r` — never a stale number (ENTL-05). `subAck.accepted[].reason` repeats the
   downgrade reason; a `downgrade` frame is also sent once when `requested tier > granted`.
3. `seq` is the per-subject composite version (`QuoteState.seq`, +1 on every applied change,
   ARCHITECTURE §6.2). `delta.prev` is the `seq` this session last received for the subject.
   **Client rule:** apply iff `prev === lastSeq[s]`; drop iff `seq <= lastSeq[s]`; otherwise send
   `resync { subjects:[s] }` and ignore deltas for `s` until the next `snap`. `seq` values may skip
   (that is conflation); the `prev` chain never does.
4. Deltas are field-wise merges. A field absent from `f` is unchanged. `null` in a delta means the
   composite value became unknown (e.g. book withdrawn) and is rendered blank; entitlement denials are
   never introduced by a delta — a grant change triggers `downgrade` + `resync` → fresh `snap`.
5. Every frame's `st` is the server's verdict at `pub`; the client recomputes `valueState()` every
   second with `core/quote/staleness.ts` (TERM-12), so a dead socket never leaves a "live" number.
6. Reconnect (BUS-07): backoff 250 ms → 8 s with jitter; `hello { resume:true }` → `welcome`; client
   re-sends `sub` for every live subscription with `known: lastSeq[s]`. The server always answers with
   fresh `snap`s; **deltas are never replayed**, so application is idempotent, gap-free and duplicate-free.
   `known` feeds only the `ws_resync_gap` metric and `usage_events kind='ws.resync'`.
7. Server-initiated `resync` (plant restart, entitlement cache reload) lists the subjects the client
   must re-`sub`; until it does, no frames for those subjects are sent.
8. Heartbeat: client `ping` every `heartbeatMs`; the server closes after 45 s silence (`4000 IDLE`).

### 6.4 Per-subscriber conflation with the latest-value guarantee (BUS-03)

`ws/conflator.ts` keeps, per session, a dirty map `subject → changed-field bitmask` in insertion
order. `plant.apply()` marks; a timer at `effectiveMs` (default `CONFLATION_MS_DEFAULT=250`, requested
range 50–5000 via `hello.conflationMs` or the `conflation` message) flushes:

- values are read **from the composite at flush time**, never from an intermediate update, so the
  flushed value of every field is the last applied value (latest-value guarantee);
- a subject appears at most once per `batch`; at most one `batch` per session per `effectiveMs`;
- a subject stays dirty until it has been sent; a skipped flush (backpressure) keeps the dirty set;
- `eod`-tier subjects flush at most every 60 000 ms; `n:*` headlines are queued, not conflated;
- the server may widen `effectiveMs` (§6.5) but never narrows below the client's request.

Property test (TESTING.md): for any input sequence, the last flushed value of every field equals the
last applied value, and the `prev` chain is contiguous per session.

### 6.5 Slow-consumer downgrade and overload (BUS-04, NFR-02)

Thresholds per session (`SOFT_BYTES = 256 KiB`, `HARD_BYTES = 2 MiB`, `GRACE_MS = 10 000`,
`MAX_MS = 5 000`), checked at every flush against `socket.bufferedAmount`:

| Condition | Action | Wire |
| --- | --- | --- |
| `bufferedAmount > SOFT` | `effectiveMs = min(effectiveMs × 2, MAX_MS)` | `notice { kind:'slow-consumer', action:'conflation-widened', conflationMs }` |
| `bufferedAmount < SOFT/4` for 3 consecutive flushes | `effectiveMs = max(effectiveMs / 2, requestedMs)` | `notice { action:'conflation-restored', conflationMs }` |
| `bufferedAmount > HARD` | skip this flush; dirty set retained (nothing lost) | — |
| `> HARD` continuously for `GRACE_MS` | shed subscriptions with `essential:false` (off-viewport rows, `n:*`, `oc:*`, `b1m:*`) | `status { s, st:'shed', reason:'SLOW_CONSUMER' }` per subject, then `notice { action:'shed' }`; client must re-`sub` when the row scrolls into view |
| still `> HARD` after another `GRACE_MS` | close | `notice { action:'disconnect-soon' }` then `bye 4008 SLOW_CONSUMER` |
| plant overload (event-loop lag > 200 ms or apply queue > 50 000) | global floor `effectiveMs ≥ 1000` for every session; shed non-essential first; `PX_LAST`, `CHG_NET_1D`, `CHG_PCT_1D` are never shed | `notice { kind:'overload', action:'conflation-widened' }` and `sys:status` delta `{ PLANT_STATE:'degraded', CONFLATION_FLOOR_MS:1000 }` |

Nothing is dropped silently: every widen/shed/close is a wire message, a metric
(`conflation_effective_ms`, `ws_buffered_bytes`) and a `dq_events kind='ws_backpressure'` row; each also
writes `usage_events kind='ws.slow'`.

### 6.6 Entitlement on subscribe and tier views (ENTL-05, BUS-06)

| Granted tier | What the subscriber sees |
| --- | --- |
| `realtime` | not attainable from any v1 source: requests are downgraded to `delayed` with `SOURCE_TIER_CAP` |
| `delayed` | identity view of Cboe/Yahoo lines (already ≥ 15 min delayed at source); `snap.tier='delayed'` |
| `eod` | `plant/eod.ts` view: `PX_OFFICIAL_CLOSE PX_CLOSE_1D PX_VOLUME PX_OPEN PX_HIGH PX_LOW` of the last completed session, `ts.src` = session close, other fields `null` with `r: 'TIER_EOD'`, flushed at most every 60 s |
| denied | subject accepted with `reason` in `NO_FIRM_ENTITLEMENT \| NO_USER_ENTITLEMENT`, all fields `null`, `st:'blank'` — or `subAck.rejected[code:'NOT_ENTITLED']` when `LICENCE_FORBIDS_USAGE` (api usage on a source with `api_allowed=false`) |

`subAck.rejected[].code` mapping: `SUBJECT_UNKNOWN` (grammar or instrument not found; also `NOT_IN_UNIVERSE`),
`NOT_ENTITLED` (`LICENCE_FORBIDS_USAGE`), `QUOTA_EXCEEDED` (§8), `FIELD_UNKNOWN`, `LIMIT` (`maxSubscriptions`/`maxFields`/frame size).
A downgrade always yields the lower tier's fresh value or a blank, never a stale higher-tier value.

### 6.7 Limits and close codes

Limits (BUS-08 scaled to v1): 10 000 subjects per web session, 2 000 per API session, 100 fields per
subject, `sub` frame ≤ 1 MiB, `batch` frame ≤ 1 MiB (split when larger), client frames ≤ 64 KiB, at most
20 client messages per second (`4029` after 3 s over the limit).

| Code | Name | When |
| --- | --- | --- |
| `1000` | normal | client close / logout |
| `1001` | server shutdown | SIGTERM; clients reconnect with backoff and resync (OPS-02) |
| `4000` | `IDLE` | no `ping` for 45 s |
| `4001` | `AUTH_REQUIRED` | no/invalid session, `hello` missing within 5 s, token revoked |
| `4002` | `PROTOCOL_ERROR` | frame fails `ClientMsg` (an `err { fatal:true }` precedes it) |
| `4003` | `SESSION_SUPERSEDED` | another web login for this user, or a newer socket on this session |
| `4008` | `SLOW_CONSUMER` | §6.5 ladder exhausted |
| `4010` | `PROTOCOL_VERSION` | `hello.protocol` not in the served set (§11) |
| `4011` | `SUBSCRIPTION_LIMIT` | repeated `sub` beyond `maxSubscriptions` after `LIMIT` rejections |
| `4029` | `RATE_LIMITED` | client message rate |

### 6.8 Example exchange (from the recorded `cboe-quote-AAPL.json` fixture)

```
→ {"t":"hello","protocol":1,"client":"web/0.1.0","conflationMs":250}
← {"t":"welcome","sessionId":"7f3c…","serverTime":1789497943123,"protocol":1,"conflationMs":250,"heartbeatMs":15000,"limits":{"maxSubscriptions":10000,"maxFields":100}}
→ {"t":"sub","id":1,"subjects":[{"s":"q:42","f":["PX_LAST","PX_BID","PX_ASK","PX_VOLUME","CHG_PCT_1D"]}]}
← {"t":"subAck","id":1,"accepted":[{"s":"q:42","tier":"delayed","reason":"SOURCE_TIER_CAP"}],"rejected":[],"traceId":"…"}
← {"t":"batch","m":[{"t":"snap","s":"q:42","seq":4182,"tier":"delayed","reason":"SOURCE_TIER_CAP",
     "f":{"PX_LAST":330.27,"PX_BID":330.25,"PX_ASK":330.28,"PX_VOLUME":16591786,"CHG_PCT_1D":-0.8436},
     "fts":{"PX_LAST":1789489586000,"PX_BID":1789489586000,"PX_ASK":1789489586000,"PX_VOLUME":1789489586000,"CHG_PCT_1D":1789489586000},
     "ts":{"src":1789489586000,"cap":1789497688412,"pub":1789497688413},"st":"live","session":"open",
     "prov":{"p":"cboe.quotes","id":88213,"seq":15972883317},"ac":"equity","id":42}]}
← {"t":"batch","m":[{"t":"delta","s":"q:42","seq":4185,"prev":4182,"f":{"PX_LAST":330.31,"PX_VOLUME":16601102},
     "ts":{"src":1789489601000,"cap":1789497703400,"pub":1789497703401},"st":"live"}]}
→ {"t":"essential","subjects":["q:42"],"essential":false}         (row scrolled out of the viewport)
← {"t":"notice","kind":"slow-consumer","action":"conflation-widened","conflationMs":500}
← {"t":"status","s":"q:42","st":"shed","reason":"SLOW_CONSUMER","ts":1789497720000}
→ {"t":"sub","id":2,"subjects":[{"s":"q:42","f":["PX_LAST","PX_BID","PX_ASK","PX_VOLUME","CHG_PCT_1D"],"known":4185}]}   (row visible again)
← {"t":"subAck","id":2,"accepted":[{"s":"q:42","tier":"delayed","reason":"SOURCE_TIER_CAP"}],"rejected":[],"traceId":"…"}
← {"t":"batch","m":[{"t":"snap","s":"q:42","seq":4190, …}]}                                    (always a fresh snapshot)
```

An `eod`-only user subscribing to the same subject receives
`accepted:[{"s":"q:42","tier":"eod","reason":"NOT_ENTITLED_TIER"}]`, a `downgrade {s:"q:42",from:"delayed",to:"eod",reason:"NOT_ENTITLED_TIER"}`
and a `snap` with `f:{"PX_LAST":null,"PX_BID":null,"PX_ASK":null,"PX_VOLUME":16591786,"CHG_PCT_1D":null}`,
`r:{"PX_LAST":"TIER_EOD","PX_BID":"TIER_EOD","PX_ASK":"TIER_EOD","CHG_PCT_1D":"TIER_EOD"}`, `st:"closed"`.

### 6.9 Non-quote subjects

- `alerts:me` — `subAck` then one `alert { alertId, firedAt, payload: AlertEvent }` per firing;
  `alerts/engine.ts` evaluates price alerts on plant deltas, news/filing alerts on ingest, calendar
  alerts on the scheduler tick (NEWS-07). Acknowledgement is REST (`/alerts/events/:id/ack`).
- `room:<roomId>` — `subAck` (rejected `NOT_ENTITLED` when not a member) then `msg { room, message }`
  per new message, in `seq` order. History and sending are REST (§5.10). Attachments render through
  the recipient's own entitlements because the client resolves them via `/results/:resultId` or a fresh
  function run (MSG-04).
- `n:*` — one `snap` with the most recent headline, then one `delta` per headline; `seq` is the
  per-scope headline counter; `prev` chain applies; wire-to-screen budget < 1 s from RSS receipt (NEWS-03 mechanism).
- `sys:status` — a `snap` on subscribe and a delta on every change; the status bar subscribes to it.

---
## 7. Field dictionary format (API-07, API-03, API-05)

The dictionary is defined once in `packages/core/src/fields/dictionary.ts` (ARCHITECTURE §15),
validated and serialised to `packages/sdk/src/fields/fields.json` by `scripts/gen-fields.ts`, served by
`GET /fields`, and used by `core/fields/format.ts` — the only formatter — so a field is formatted the same
way on the screen, in the CSV and in the SDK. Its version is recorded in
`schema_meta('field_dictionary_version')` and returned as `dictionaryVersion` by `/auth/session` and `/status`.

```ts
// packages/core/src/fields/dictionary.ts (TypeScript source of truth) — zod mirror FieldDef in sdk/wire/rest.ts
export interface FieldDef {
  id: FieldId;                                   // 'PX_LAST'; stable, never reused
  label: string;                                 // 'Last price' (column header)
  definition: string;                            // one unambiguous paragraph
  type: 'number'|'integer'|'string'|'boolean'|'date'|'datetime'|'enum';
  unit: 'price'|'pct'|'bp'|'shares'|'contracts'|'ccy'|'ratio'|'years'|'days'|'count'|'bn'|'text'|'date'|'datetime'|'enum'|null;
  decimals: number|null;                         // null = instrument price_decimals (prices) or unit default
  enumValues?: readonly string[];
  fieldClass: FieldClass;                        // = field_licence.field_class (entitlement dimension)
  assetClasses: readonly AssetClass[];           // where the field is meaningful; [] for subject-only fields (n:, c:, e:, sys:)
  sources: ReadonlyArray<{ assetClass: AssetClass|'*'; sourceId: string; endpoint: string; providerPath: string }>;   // = field_licence rows + the raw path (e.g. cboe.quotes → data.current_price)
  updateFreq: 'tick'|'10s'|'1m'|'daily'|'weekly'|'twice_monthly'|'monthly'|'quarterly'|'annual'|'on_filing'|'static';
  pit: boolean;                                  // true = value depends on knownAt (fundamentals, econ vintages, terms)
  derivation?: string;                           // for fieldClass 'derived'/'analytic': the formula or engine name (ANAL-08)
  example: { ref: string; value: number|string|boolean; asOf: string };   // worked example from a recorded fixture
  since: string;                                 // dictionary version that introduced it
  deprecated?: { since: string; replacement: FieldId|null; removeAfter: string };
}
export const FieldDictionary = z.object({ version: z.string() /* '2026.09.1' */, generatedAt: z.iso.datetime(), fields: z.array(FieldDef) });
export const LicenceSummary = z.object({ sourceId: z.string(), sourceName: z.string(), publisher: z.string(), licenceKind: z.string(), attribution: z.string(),
  display: z.boolean(), exportAllowed: z.boolean(), apiAllowed: z.boolean(), redistribution: z.boolean(), maxTier: Tier, intrinsicDelayMin: z.number().int(), retentionDays: z.number().int().nullable(), termsUrl: z.string().nullable() });
```

Excerpt (full list ≈ 220 ids; every id below is cited by ARCHITECTURE `QuoteFields` or a function manifest):

| id | type/unit | fieldClass | source (equity unless noted) | updateFreq | pit |
| --- | --- | --- | --- | --- | --- |
| `PX_LAST`, `LAST_SIZE`, `LAST_TRADE_TIME` | number/price, integer/shares, datetime | price | `cboe.quotes` `data.current_price` / `last_trade_time`; `yahoo.chart` `meta.regularMarketPrice` (priority 20) | tick (polled 10 s) | no |
| `PX_BID`, `PX_ASK`, `BID_SIZE`, `ASK_SIZE` | price / shares | price | `cboe.quotes` `data.bid/ask/bid_size/ask_size` | tick | no |
| `PX_OPEN`, `PX_HIGH`, `PX_LOW`, `PX_CLOSE_1D`, `PX_OFFICIAL_CLOSE`, `PX_VOLUME`, `VWAP` | price / shares | price | `cboe.quotes` `open/high/low/prev_day_close/close/volume`; history from `bars_daily` | tick / daily | no |
| `CHG_NET_1D`, `CHG_PCT_1D`, `TICK_DIR` | price / pct / enum(up,down,flat) | derived | `core/quote/derive.ts`: `PX_LAST − PX_CLOSE_1D`, never a provider value | tick | no |
| `SESSION_STATE`, `STALENESS` | enum | derived | plant (`core/quote/session.ts`, `staleness.ts`) | tick | no |
| `IVOL_30D` | pct | analytic | `cboe.quotes` `data.iv30` | tick | no |
| `TOT_RETURN_INDEX` | ratio | derived | `core/adjust/corporateActions.ts#totalReturnIndex` | daily | no (policy param) |
| `NAME`, `TICKER`, `EXCH_CODE`, `ID_ISIN`, `ID_CUSIP`, `ID_SEDOL`, `ID_BB_GLOBAL`, `ID_BB_GLOBAL_COMPOSITE`, `ID_BB_GLOBAL_SHARE_CLASS`, `ID_LEI`, `ID_CIK`, `CRNCY`, `SECURITY_TYP`, `MARKET_SECTOR_DES`, `SIC_CODE`, `GICS_SECTOR_NAME`, `COUNTRY_OF_INCORP`, `FISCAL_YEAR_END`, `FIRST_TRADE_DT` | text / date | reference | `openfigi.mapping`, `sec.tickers`, `sec.submissions`, `wiki.sp500` (GICS) | daily / static | yes (valid/known) |
| `EQY_SH_OUT`, `PUBLIC_FLOAT`, `CUR_MKT_CAP` | shares / ccy | reference / derived | `sec.companyfacts` `dei:EntityCommonStockSharesOutstanding`; `CUR_MKT_CAP = PX_LAST × EQY_SH_OUT` | on_filing | yes |
| `SALES_REV_TURN`, `GROSS_PROFIT`, `IS_OPER_INC`, `NET_INCOME`, `IS_EPS_DIL`, `BS_TOT_ASSET`, `BS_TOT_LIAB2`, `TOTAL_EQUITY`, `CF_CASH_FROM_OPER`, `CF_CAP_EXPEND`, `FREE_CASH_FLOW`, `DVD_SH_12M`, `PE_RATIO`, `PX_TO_BOOK_RATIO`, `EV_TO_EBITDA`, `RETURN_COM_EQY`, `FA_FILED_AT` | number / ratio | fundamental / derived | `sec.companyfacts` via `xbrl_concept_map` → `fin_statements` | quarterly (on_filing) | **yes** (STOR-06) |
| `EE_NEXT_REPORT_DT`, `EE_EPS_ACTUAL_LAST`, `EE_EPS_ESTIMATE`, `EE_SURPRISE_PCT` | date / number | fundamental | SEC actuals; `EE_EPS_ESTIMATE`/`EE_SURPRISE_PCT` always `meta.unavailable` `NO_SOURCE` | on_filing | yes |
| `MTY_YEARS`, `CPN`, `CPN_FREQ`, `DAY_CNT_DES`, `MATURITY`, `ISSUE_DT`, `SECURITY_TYP` (govt) | number / text / date | reference (govt) | `treasury.bills`, `fixtures/seed/treasuries.json` | daily | yes |
| `YLD_YTM_MID`, `PX_DIRTY_MID`, `ACCRUED`, `DUR_MID`, `DUR_ADJ_MID`, `CONVEXITY_MID`, `DV01`, `KRD_2Y`, `KRD_5Y`, `KRD_10Y`, `KRD_30Y`, `DISC_RATE`, `BEY` | number | analytic (govt) | `core/analytics/bond/*`, `bill.ts` (engine name/version in `meta.engines`) | daily | terms yes |
| `OPT_STRIKE_PX`, `OPT_EXPIRE_DT`, `OPT_PUT_CALL`, `OPT_UNDL_TICKER`, `OPT_CONT_SIZE`, `OPT_OI`, `OPT_IV`, `OPT_DELTA`, `OPT_GAMMA`, `OPT_VEGA`, `OPT_THETA`, `OPT_RHO`, `OPT_THEO`, `OPT_UNDL_PX` | number | reference / price / analytic (option) | `cboe.options` `data.options[]` (`iv, delta, gamma, vega, theta, rho, theo, open_interest`) | 1m | no |
| `RATE`, `RATE_P1`, `RATE_P25`, `RATE_P75`, `RATE_P99`, `RATE_VOLUME_BN`, `TARGET_FROM`, `TARGET_TO`, `RATE_AVG_30D`, `RATE_AVG_90D`, `RATE_AVG_180D`, `RATE_INDEX` | pct / bn | econ (rate) | `nyfed.rates` `refRates[].percentRate/percentPercentile1…/volumeInBillions/targetRateFrom/To`; `fed.h15` | daily | yes (vintage) |
| `ECO_VALUE`, `ECO_PERIOD`, `ECO_VINTAGE`, `ECO_PRIOR`, `ECO_REVISED_PRIOR`, `ECO_RELEASE_DT`, `ECO_SURVEY` | number / date | econ | `fred.csv`, `bls.timeseries`, `worldbank`, `imf.datamapper`; `ECO_SURVEY` always unavailable `NO_SOURCE` | per release | **yes** |
| `CRV_1M` … `CRV_30Y`, `CURVE_PAR`, `CURVE_ZERO`, `CURVE_DF`, `CURVE_FWD_3M` | pct | analytic (curve) | `treasury.yieldcurve` `BC_1MONTH…BC_30YEAR`; `internal.derived` builds | daily | yes (vintage) |
| `IDX_MEMBER_WEIGHT`, `IDX_MEMBER_SINCE`, `IDX_MEMBER_SHARES` | ratio / date / shares | reference | `sec.archives` N-PORT `pctVal`, `ssga.holdings` | monthly / daily | yes |
| `SHORT_INT`, `SHORT_INT_RATIO`, `SHORT_INT_DT` | shares / ratio / date | reference | `finra.shortInterest` | twice_monthly | no |
| `RET_1D`, `RET_YTD`, `VOL_30D`, `VOL_90D`, `BETA_1Y`, `CORR_1Y`, `SHARPE_1Y`, `MAX_DD_1Y` | pct / ratio | analytic | `core/analytics/stats` (conventions echoed in `meta.engines`) | daily | no |
| `PORT_WEIGHT`, `PORT_MV`, `PORT_PNL_1D`, `PORT_ACTIVE_WEIGHT`, `PORT_CONTRIB_TE` | ratio / ccy | portfolio | `portfolio/service.ts` (tenant data, never exported outside the firm) | tick / daily | no |
| `NEWS_ID`, `HEADLINE`, `PUBLISHED_AT`, `SOURCE_ID`, `LINK`, `KIND`, `IS_CORRECTION` | text / datetime | news | `bbg.rss`, `sec.atom`, `fed.rss` | tick | no |
| `BAR_TS`, `IS_FINAL` | datetime / boolean | derived | `yahoo.chart` 1-minute bars | 1m | no |
| `PLANT_STATE`, `CONFLATION_FLOOR_MS`, `PROVIDERS_DOWN`, `SESSION_NYSE`, `SESSION_SIFMA`, `SESSION_FX`, `SERVER_TIME`, `OPEN_INCIDENTS`, `MIN_CLIENT_VERSION` | enum / integer / text / datetime | derived | `sys:status` only | tick | no |

Rules: (1) `field_licence` must contain a row for every `(id, assetClass)` pair in `sources`; startup
fails otherwise (ARCHITECTURE §12.1). (2) Ids never change meaning; a semantic change is a new id.
(3) Deprecation (API-03): a field is `deprecated` for at least two dictionary minor versions and six
months before removal; the server keeps serving it and adds `x-deprecated-fields: PX_PREV_CLOSE` to the
response; the SDK logs one warning per process per deprecated id; `GET /fields/changelog` lists every
change; `GET /fields?version=` serves prior versions for the same window. (4) The web build pins the
dictionary version it was built against and refuses to start on a major mismatch (§11).
(5) Value identity (API-05): a field is one value at one `(validAt, knownAt)` regardless of surface —
`server/test/parity/fn-parity.test.ts` runs every manifest through resolver → JSON → CSV → WS snapshot at a
frozen clock and asserts numeric equality.

---

## 8. Quotas and rate limits (API-06)

Enforced by `entitlements/quotas.ts` (evaluator rule 8) server-side for every `usage:'api'` session
(bearer keys); counted and reported — but not enforced — for web sessions, so the status bar can show
them. Limits live in `quota_limits` per user, falling back to the firm row, then the defaults.

| Quota | Default (api) | Counting rule | Store | Error |
| --- | --- | --- | --- | --- |
| Daily unique instruments | 500 / user / UTC day | insert-if-absent per `(user, day, instrument)` on every data read, function run, export and WS `sub` | `quota_instruments_seen` | `429 QUOTA_EXCEEDED { quota:'dailyUniqueInstruments', used, limit, resetsAt }`; WS `subAck.rejected[code:'QUOTA_EXCEEDED']` |
| Monthly data points | 2 000 000 / user / calendar month | reference/realtime `securities × fields`; series `rows × columns`; ticks `count`; function payloads `csv rows × columns` (or 1 per screen block when not tabular); WS: fields in each flushed delta/snap for api sessions | `quota_counters (window_kind='month')` | same, `quota:'monthlyDataPoints'` |
| Concurrent subscriptions | 2 000 per api session; 10 000 per web session (BUS-08) | live subject count in `ws/session.ts` | in memory (plant) | `subAck.rejected[code:'QUOTA_EXCEEDED']` (api) / `LIMIT` (web ceiling) |

Counters are incremented in the same transaction as the access-log batch (never on the response
path). Headers on every data-bearing response: `x-quota-daily-instruments: <used>/<limit>`,
`x-quota-monthly-datapoints: <used>/<limit>`, `x-quota-concurrent-subs: <used>/<limit>`; `GET /usage/quota`
and `SessionInfo.quotas` show the same numbers. Limits are checked **before** any provider fetch, so an
over-quota request costs nothing upstream.

Route rate limits (token bucket per session, header `Retry-After` seconds, `429 RATE_LIMITED`):

| Scope | Limit |
| --- | --- |
| REST, per session | 20 req/s, burst 60 |
| `/search` | 30 req/s, burst 60 |
| `/data` with `kind:'tick'` or `historical` over 10 years | 5 req/s |
| Export routes (§9) | 2 req/s, 60 per hour |
| `/auth/login`, `/auth/webauthn/login/*` | 5 per minute per IP, 20 per hour per email |
| `/usage/events` | 1 req/s (batch of ≤ 100) |
| WS client messages | 20 msg/s (§6.7) |

---

## 9. Export endpoints (FUNC-03, API-05, ENTL-01)

Export runs the **same resolver and the same `core/functions/csv.ts#toCsv`** as the screen; numbers are
the cached payload's numbers, so CSV = screen by construction (ARCHITECTURE §15 "Export equality").
Excel is a non-goal (BRIEF §1): the CSV opens in Excel; the JS SDK is the programmatic path.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/functions/:code/csv` | `resultId` (preferred: the payload's `meta.resultId`); or `params=<base64url JSON>` + `security?` + `validAt` + `knownAt` when the result has expired (re-resolve at that `asOf` through the same resolver) | `200 text/csv; charset=utf-8` |
| POST | `/data/csv` | `DataRequest` (any kind except `realtime` with > 500 securities) | `200 text/csv`; reference → one row per security; historical/intraday → one row per `(security, index)` with the requested columns; tick → one row per tick |
| GET | `/watchlists/:watchlistId/export.csv` | — | the W grid with the same field values the screen shows (resolved via `kind:'realtime'`), computed columns evaluated by `core/formula` |
| GET | `/portfolios/:portfolioId/export.csv` | `asOfDate?` | positions with the PORT analytics columns (firm only) |
| GET | `/admin/access-log/export.csv`, `/admin/declarations?format=csv` | §5.14 | compliance exports |

Entitlement (FUNC-03 "including entitlement checks on export"): the evaluator re-runs with
`usage:'export'`, `purpose:'export:<CODE>'` for a bearer or cookie session alike. **Any denied field
fails the whole export** with `403 ENTITLEMENT_DENIED` and `details.reasons[]` — a subset is never
silently exported (ARCHITECTURE §10 rule 2); `LICENCE_FORBIDS_USAGE` is the reason when
`licence_registry.export_allowed=false`. Every export writes `usage_events kind='fn.export'` and the
access-log rows, and charges the datapoint quota.

CSV document (`CsvDocument` in ARCHITECTURE §5.2): UTF-8, RFC 4180 quoting, `\r\n` line ends, no BOM.

```
# terminal-export v1
# function: HP  security: AAPL US Equity  params: {"range":"1Y","adjust":"price"}
# asOf: validAt=2026-09-15T18:41:28Z knownAt=2026-09-15T18:41:28Z  tier: delayed  staleness: closed
# source: Yahoo Finance chart v8 (unofficial; 15-min delayed); Cboe delayed quotes (exchange-published, 15-min delayed)
# provenance: 88213,88214  engines: adjust/1.0.0  trace: 3f2a…  regenerated: false
date,PX_OPEN,PX_HIGH,PX_LOW,PX_LAST,PX_VOLUME
2026-09-15,330.24,331.59,328.35,330.27,16591786
```

Leading `#` lines carry the attribution required by `licence_registry.attribution`; numbers are
unformatted at full stored precision (≤ 15 significant digits; the screen rounds through the same
formatter), dates ISO, booleans `true`/`false`, blanks empty. Response headers: `x-trace-id`,
`x-as-of-valid`, `x-as-of-known`, `x-provenance` (comma-separated ids), `x-engine-version`,
`x-regenerated: true|false`, `content-disposition: attachment; filename="<CODE>_<display-with-underscores>_<validAt-compact>.csv"`
(`HP_AAPL_US_Equity_20260915T184128Z.csv`, from `manifest.csv.filename`).

---
## 10. The `@terminal/sdk` surface (API-01, API-03, API-05)

One package for the web client and for external users (browser and Node 22; ESM; peer dependency
`@terminal/core`). The web client imports only from here (ARCHITECTURE §1.1), so every number the
terminal shows is reachable through this surface. Python/R/Java/C++/C# clients (API-03) are out of v1
scope; the wire schemas in `wire/*` and the generated `fields.json` are the contract they would bind to.

```ts
// packages/sdk/src/index.ts
export interface ClientOptions {
  baseUrl: string;                               // 'https://host' — REST at baseUrl + '/api/v1', WS at ws(s)://host/ws/v1
  token?: string;                                // bearer API key; omitted for cookie sessions (browser)
  clientVersion: string;                         // 'web/0.1.0' | 'sdk-js/0.1.0' → x-client-version, hello.client
  fetch?: typeof fetch; WebSocket?: typeof WebSocket;   // injectable for tests / Node
  traceId?: () => string;                        // default crypto.randomUUID(); one per user action (OPS-07)
  onTrace?: (e: { traceId: string; route: string; ms: number; status: number }) => void;
  onVersion?: (e: { serverVersion: string; minClientVersion: string; dictionaryVersion: string }) => void;   // §11
  conflationMs?: number;                         // default 250
}
export function createClient(opts: ClientOptions): TerminalClient;

export interface TerminalClient {
  readonly rest: RestClient;                     // raw typed transport (every route in §5)
  readonly live: LiveClient;                     // WebSocket (§6)
  readonly fields: FieldsApi;                    // dictionary + format()
  readonly functions: FunctionRegistry;          // re-export of core registry (manifests: params, paramGrammar, live(), csv, help)
  // convenience namespaces — thin, typed wrappers over rest.* with client-side caching where noted
  auth:       { login(req: LoginRequest): Promise<LoginResponse>; logout(): Promise<void>; session(): Promise<SessionInfo>; webauthn: WebAuthnApi; apiKeys: ApiKeysApi };
  ref:        { resolve(ref: SecurityRefInput, opts?: { asOf?: AsOf; panelSecurityId?: number }): Promise<ResolveItem>;      // 5-min LRU cache keyed (ref, asOf)
                resolveMany(refs: SecurityRefInput[], opts?): Promise<ResolveItem[]>;
                get(instrumentId: number, asOf?: AsOf): Promise<InstrumentDetail>; versions(instrumentId, table?): Promise<VersionRow[]>;
                corporateActions(instrumentId, q?): Promise<CorporateAction[]>; members(indexInstrumentId, q?): Promise<MembersResponse>; calendar(id, from, to): Promise<CalendarResponse> };
  search:     { query(q: SearchQuery): Promise<SearchResponse>; universe(): Promise<UniverseSnapshot> };   // universe(): ETag + IndexedDB/memory cache
  data:       { request(req: DataRequest): Promise<DataResponse>;                                            // POST /data (all five kinds; 'realtime' = one-shot)
                reference(securities, fields, asOf?): Promise<DataResponse>; history(security, q: HistoryQuery): Promise<SeriesBlock & { meta: Meta }>;
                intraday(security, q): Promise<SeriesBlock & { meta: Meta }>; ticks(security, q): AsyncIterable<TickRow>;   // follows nextCursor
                snapshot(securities, fields, tier?): Promise<DataResponse>;
                curve(curveId, q?): Promise<CurveResponse>; rate(code, q?): Promise<RateResponse>; econ(seriesCode, q?): Promise<EconResponse>; econCalendar(q): Promise<EconCalendarResponse>;
                optionChain(underlying, q?): Promise<ChainResponse>; holders(instrumentId, q?): Promise<HoldersResponse>;
                subscribe(req: Extract<DataRequest, { kind: 'realtime' }>): Promise<Subscription> };        // resolves securities → subjects, then live.subscribe (API-02)
  fn:         { list(): Promise<FunctionManifestPublic[]>;
                run<C extends FunctionCode>(code: C, req: FunctionRunRequest, opts?: { traceId?: string }): Promise<Payload<PayloadOf<C>>>;   // typed by manifest
                page(code, resultId, direction: 'fwd'|'back'): Promise<Payload<unknown>>; result(resultId): Promise<Payload<unknown>>;
                help(code, assetClass?): Promise<HelpResponse>;
                csvUrl(code, args: { resultId } | { params; security?; validAt; knownAt }): string;      // for PRINT → browser navigation; never serialises locally
                csv(code, args): Promise<{ text: string; headers: Record<string,string> }> };
  news:       { search(q: NewsQuery): Promise<{ items: NewsItem[]; nextCursor: string|null; meta: Meta }>; top(scope, id?, limit?): Promise<NewsItem[]>; get(newsId): Promise<NewsItem>; topics(): Promise<Topic[]> };
  workspace:  { get(): Promise<Workspace>; put(version: number, layout: WorkspaceLayout): Promise<{ version: number }>; list(); create(name, layout); update(id, patch); remove(id); activate(id);
                annotations: { list(instrumentId): Promise<ChartAnnotation[]>; create(a); update(id, a); remove(id) } };
  watchlists: { list(): Promise<Watchlist[]>; get(id): Promise<Watchlist>; create(w): Promise<Watchlist>; update(id, w): Promise<Watchlist>; remove(id): Promise<void>; setItems(id, items: WatchlistItemInput[]): Promise<Watchlist>; exportCsvUrl(id): string };
  portfolios: { list(); get(id); create(p); update(id, p); remove(id); positions(id, asOfDate?): Promise<Position[]>; putPositions(id, asOfDate, rows: PositionInput[]): Promise<ImportReport>;
                importCsv(id, file: Blob|Buffer, asOfDate: string): Promise<ImportReport>; imports(id); lots(id); analytics(id, req): Promise<Payload<PortPayload>> };
  messaging:  { rooms(): Promise<Room[]>; room(id): Promise<Room>; createRoom(req): Promise<Room>; messages(roomId, q?): Promise<{ items: Message[]; nextCursor }>;
                send(roomId, req: SendMessage): Promise<Message>;   // generates clientMsgId (uuid) and retries idempotently
                markRead(roomId, lastReadSeq): Promise<void>; directory(q): Promise<DirectoryEntry[]> };
  alerts:     { list(); create(a); update(id, a); remove(id); events(since?): Promise<AlertEvent[]>; ack(eventId): Promise<void>; savedSearches: SavedSearchesApi };
  help:       { get(code, assetClass?): Promise<HelpResponse>; openTicket(req: TicketRequest): Promise<{ ticketId: number; roomId: number }>; tickets(): Promise<Ticket[]> };
  usage:      { events(events: UsageEvent[]): Promise<void>;   // buffered, flushed every 5 s or 100 events, and on pagehide
                quota(): Promise<QuotaResponse>; entitlements(): Promise<EntitlementsResponse> };
  admin:      AdminApi;                          // §5.14, role-gated server-side
  status():   Promise<StatusResponse>; health(): Promise<HealthResponse>;
  close():    void;                              // closes the WS, flushes usage events
}
```

### 10.1 `RestClient` — `client/rest.ts`

```ts
export class RestClient {
  constructor(opts: ClientOptions);
  request<R extends RouteId>(route: R, args: RouteArgs<R>, init?: { traceId?: string; signal?: AbortSignal }): Promise<RouteResponse<R>>;
  //  RouteId = keyof typeof Rest ('Auth.Login', 'Data.Request', 'Functions.Run', …); args are { params?, query?, body? } typed by the zod objects;
  //  sends x-trace-id, x-client-version, x-requested-with: terminal (cookie mode) or Authorization (bearer mode);
  //  parses the body with the route's response schema (throws TerminalApiError { code:'VALIDATION_FAILED', details.issues } on drift);
  //  honours ETag for Universe.Snapshot and Functions.List; surfaces x-quota-* and x-deprecated-fields via onTrace/onVersion callbacks.
}
export class TerminalApiError extends Error {
  code: ErrorCode; status: number; traceId: string; retryable: boolean; retryAfterMs?: number; details?: Record<string, unknown>;
}
```

### 10.2 `LiveClient` and subscriptions — `client/ws.ts`, `client/subscriptions.ts`, `client/quoteCache.ts`

```ts
export type LiveState = 'idle'|'connecting'|'open'|'resyncing'|'closed';
export interface SubscribeOptions { tier?: Tier; essential?: boolean; conflationMs?: number }
export interface UpdateEvent { subject: string; seq: number; changed: FieldId[]; state: QuoteView; kind: 'snap'|'delta' }
export interface QuoteView {                    // the SDK's projection of QuoteState for one subject (values ⊆ subscribed fields)
  subject: string; instrumentId: number|null; assetClass: AssetClass|null; seq: number; tier: Tier; reason: ReasonCode;
  f: Record<FieldId, FieldValue>; fts: Record<FieldId, number>; r: Record<FieldId, ReasonCode>;
  ts: { src: number|null; cap: number; pub: number }; st: ValueState; session: SessionState; prov: { p: string; id: number; seq?: number };
  status: 'live'|'pending'|'shed'|'gone'|null;   // last Status frame
}
export class LiveClient {
  constructor(opts: ClientOptions);
  readonly state: LiveState; readonly sessionId: string|null; readonly conflationMs: number; readonly limits: { maxSubscriptions: number; maxFields: number };
  connect(): Promise<void>;                     // hello/welcome; auto-reconnect with 250 ms → 8 s jittered backoff (BUS-07); resume:true after the first connect
  close(code?: number): void;
  subscribe(subjects: string[], fields: FieldId[] | '*', opts?: SubscribeOptions): Subscription;   // ref-counted per (subject, field); batches sub/unsub per animation frame
  setEssential(subjects: string[], essential: boolean): void;                                     // viewport → 'essential' message
  setConflation(ms: number): void;
  get(subject: string): QuoteView | undefined;   // from QuoteCache
  on(event: 'update', h: (e: UpdateEvent) => void): () => void;
  on(event: 'status', h: (e: { subject: string; st: Status['st']; reason?: string }) => void): () => void;
  on(event: 'downgrade', h: (e: { subject?: string; from: Tier; to: Tier|null; reason: ReasonCode }) => void): () => void;
  on(event: 'notice', h: (e: Notice) => void): () => void;                                        // slow-consumer / overload / maintenance (BUS-04)
  on(event: 'alert', h: (e: AlertEvent) => void): () => void;
  on(event: 'message', h: (e: { room: string; message: Message }) => void): () => void;
  on(event: 'state', h: (s: LiveState) => void): () => void;
  on(event: 'error', h: (e: { code: string; message: string; traceId: string; fatal: boolean }) => void): () => void;
  on(event: 'close', h: (e: { code: number; reason: string }) => void): () => void;
}
export interface Subscription {
  readonly id: number; readonly subjects: readonly string[]; readonly fields: readonly FieldId[] | '*';
  readonly ack: Promise<{ accepted: Array<{ s: string; tier: Tier; reason: ReasonCode }>; rejected: Array<{ s: string; code: string; reason: string }> }>;
  on(event: 'update', h: (e: UpdateEvent) => void): () => void;   // only subjects/fields of this subscription
  unsubscribe(): void;                                              // ref-count decrement; 'unsub' sent when it reaches zero
}
export class QuoteCache {                        // Map<subject, QuoteView>; applies snap/delta with the prev-chain rule (§6.3); 1 s staleness ticker (TERM-12)
  apply(msg: Snap | Delta | Status): { changed: FieldId[]; resyncNeeded: boolean };
  sweep(now: number): string[];                  // subjects whose valueState changed (core/quote/staleness.ts)
}
```

Client-side invariants: `apply()` implements rule 3 of §6.3 exactly (`prev === lastSeq` apply; `seq <=
lastSeq` drop; else `resync`); after `bye 1001`/network loss the client reconnects and re-subscribes with
`known`; `status 'shed'` subjects are re-subscribed automatically when `setEssential(…, true)` is called
(the grid does this when a row scrolls into view). `UpdateEvent.changed` is what `web/grid/cellRegistry`
flashes (ARCHITECTURE §6.6).

### 10.3 `FieldsApi` and `FunctionRegistry`

```ts
export interface FieldsApi {
  readonly version: string; get(id: FieldId): FieldDef | undefined; list(filter?: { fieldClass?: FieldClass; assetClass?: AssetClass }): FieldDef[];
  format(id: FieldId, value: FieldValue, opts?: { priceDecimals?: number; locale?: string }): string;   // re-export of core/fields/format.ts (the only formatter)
  refresh(): Promise<void>;                      // GET /fields; warns on deprecated ids in use
}
export interface FunctionRegistry {              // re-export of core/functions/registry.ts
  get(codeOrAlias: string): FunctionManifest | undefined; all(): FunctionManifest[]; byTier(t: 1|2|3): FunctionManifest[]; applicable(assetClass: AssetClass | null): FunctionManifest[];
}
export function runFunction<C extends FunctionCode>(client: TerminalClient, code: C, req: FunctionRunRequest): Promise<Payload<PayloadOf<C>>>;   // = client.fn.run; params validated locally by manifest.params before the request
```

### 10.4 Minimal usage

```ts
import { createClient } from '@terminal/sdk';
const api = createClient({ baseUrl: 'http://localhost:8080', token: process.env.TERMINAL_API_KEY, clientVersion: 'sdk-js/0.1.0' });
const { instrument } = await api.ref.resolve({ ref: 'AAPL US Equity' });
const hist = await api.data.request({ kind: 'historical', securities: [{ id: instrument!.instrumentId }], fields: ['PX_LAST'], start: '2020-01-01', end: '2020-12-31', adjust: 'price' });
const des  = await api.fn.run('DES', { security: { ref: 'AAPL US Equity' } });
const sub  = await api.data.subscribe({ kind: 'realtime', securities: [{ ref: 'AAPL US Equity' }, { ref: 'SPX Index' }], fields: ['PX_LAST','CHG_PCT_1D'] });
sub.on('update', ({ subject, state, changed }) => console.log(subject, changed.map(f => api.fields.format(f, state.f[f]))));
```

---

## 11. Versioning and compatibility (OPS-02, API-03)

| Layer | Rule |
| --- | --- |
| REST path | `/api/v1`. Within `v1` changes are **additive only**: new routes, new optional request fields, new response fields, new enum members on server→client enums (clients must tolerate unknown members — the SDK's zod enums for server-produced values are `z.string()`-tolerant via `.catch()` on display-only enums). Breaking changes go to `/api/v2`, served alongside `v1` for at least two minor client releases and 90 days. |
| WS protocol | `hello.protocol` (integer). The server serves the current version and the previous one (`StatusResponse.protocol` lists them); an unsupported value gets `bye 4010`. New message types and new optional fields do not bump the version; a client ignores `t` values it does not know. |
| Client version | `x-client-version` / `hello.client` = `<package>/<semver>`. `/auth/session`, `/status` and the `sys:status` field `MIN_CLIENT_VERSION` publish `minClientVersion`. Below it: REST answers `426 PROTOCOL_VERSION` **only** for a genuinely incompatible major; otherwise the server keeps serving and the web client shows a "reload for the new version" badge (`notice { kind:'maintenance', action:'disconnect-soon', detail:'client-version' }` is advisory; live sessions are never disconnected for a deploy). |
| Rolling deploy | SIGTERM → `bye 1001` after the new process is listening; clients reconnect with backoff and resync through fresh snapshots (§6.3); no delta log means no cross-version replay format to maintain. |
| Field dictionary | semver-like `YYYY.MM.N`; deprecation window per §7; the web build pins its dictionary version and refuses to start on a major (`YYYY`) mismatch. |
| Function payloads | `PayloadMeta` is stable; each `data` shape carries `variant` and is versioned by the manifest (`FUNCTIONS.md`); removing a field from a payload is a breaking change handled like a route. |
| SDK | `@terminal/sdk` follows semver; a minor release may add methods; the wire schemas it ships are the ones the server it targets validates with, and `test/contract.test.ts` round-trips every example in this document. |
| Headers | `x-server-version`, `x-deprecated-fields`, `Deprecation: true` + `Sunset: <date>` on routes scheduled for removal. |

---

## 12. Worked examples

### 12.1 Login, then a historical read with adjustment (REF-09, STOR-06)

```
POST /api/v1/auth/login           x-requested-with: terminal   x-trace-id: 5c0e…
{ "email": "pm@demo.terminal", "password": "correct horse battery staple", "deviceId": "d_9f3a1c2b7e" }

200  Set-Cookie: tsid=…; HttpOnly; SameSite=Strict; Path=/
{ "session": { "sessionId": "6a1c…", "userId": 2, "firmId": 1, "firmName": "Demo Capital", "email": "pm@demo.terminal", "displayName": "Demo PM",
    "desk": "Equities PM", "role": "user", "clientKind": "web", "mfaRequired": false, "mfaVerified": false, "webauthnEnrolled": false,
    "createdAt": "2026-09-15T18:40:00Z", "expiresAt": "2026-09-22T18:40:00Z",
    "entitlementSummary": { "defaultTier": "delayed", "exportAllowed": true, "apiAllowed": true },
    "quotas": { "dailyUniqueInstruments": { "used": 0, "limit": 500, "resetsAt": "2026-09-16T00:00:00Z" }, "monthlyDataPoints": { "used": 0, "limit": 2000000, "resetsAt": "2026-10-01T00:00:00Z" },
                "concurrentSubscriptions": { "used": 0, "limit": 10000, "resetsAt": "2026-09-15T18:40:00Z" } },
    "protocol": 1, "serverVersion": "0.1.0", "minClientVersion": "0.1.0", "dictionaryVersion": "2026.09.1" },
  "mfaRequired": false,
  "superseded": { "sessionId": "58b0…", "deviceId": "d_11aa…", "deviceLabel": "Chrome on macOS", "lastSeenAt": "2026-09-15T17:02:11Z" } }

POST /api/v1/data
{ "kind": "historical", "securities": [{ "ref": "AAPL US Equity" }], "fields": ["PX_LAST"], "start": "2020-08-27", "end": "2020-09-01",
  "adjust": "price", "asOf": { "knownAt": "2026-09-15T00:00:00Z" } }

200
{ "meta": { "traceId": "5c0e…", "asOf": { "validAt": "2026-09-15T18:41:30.002Z", "knownAt": "2026-09-15T00:00:00Z" }, "tier": "eod", "staleness": "closed",
            "provenance": [{ "idx": 0, "sourceId": "yahoo.chart", "provenanceId": 91177, "capturedAt": "2026-09-15T18:41:28Z", "sourceTs": null, "attribution": "Yahoo Finance chart v8 (unofficial; 15-min delayed)" }],
            "entitlement": [], "unavailable": [], "engines": [{ "name": "adjust", "version": "1.0.0", "inputsHash": "9b1e…" }],
            "adjustments": [{ "beforeDate": "2020-08-31", "priceFactor": 0.25, "volumeFactor": 4, "kind": "split" }],
            "servedAt": "2026-09-15T18:41:30.002Z", "quota": { "dataPointsCharged": 4, "uniqueInstrumentsAdded": 1 } },
  "results": [{ "security": { "ref": "AAPL US Equity" },
                "instrument": { "instrumentId": 42, "assetClass": "equity", "marketSector": "Equity", "display": "AAPL US Equity", "name": "Apple Inc", "currency": "USD",
                                "primaryListingId": 7, "mdLineIds": [101, 102], "ticker": "AAPL", "exchCode": "US", "securityType": "Common Stock", "compositeFigi": "BBG000B9XRY4", "status": "active", "priceDecimals": 2 },
                "series": { "columns": ["PX_LAST"], "index": ["2020-08-27","2020-08-28","2020-08-31","2020-09-01"], "rows": [[125.0100],[124.8075],[129.04],[134.18]], "adjust": "price", "currency": "USD", "provIdx": [0] },
                "tier": "eod", "st": "closed" }] }
```

The same request with `"asOf": { "knownAt": "2020-07-30T00:00:00Z" }` returns `[[500.04],[499.23],…]`
with an empty `adjustments` array: the 4:1 split was recorded on 2020-07-31, so as of what we knew on
30 July it did not exist (REF-03 + REF-09 together; golden values from `fixtures/golden/analytics/adjust/aapl.json`).

### 12.2 Function run, then PRINT

```
POST /api/v1/functions/HP/run
{ "security": { "ref": "AAPL US Equity" }, "params": { "range": "1M", "periodicity": "D", "adjust": "price" }, "panelId": "p1", "launchKind": "launch" }

200 { "data": { "variant": "equity", "rows": [ … ], "columns": [ … ] },
      "meta": { "resultId": "01J8ZC5Q9W3F5X0T6M2N4V8Y7A", "traceId": "…", "asOf": { … }, "tier": "delayed", "staleness": "closed", "provenance": [ … ], "entitlement": [], "unavailable": [], "engines": [ … ], "servedAt": "…" } }

GET /api/v1/functions/HP/csv?resultId=01J8ZC5Q9W3F5X0T6M2N4V8Y7A
200 text/csv   x-regenerated: false   content-disposition: attachment; filename="HP_AAPL_US_Equity_20260915T184128Z.csv"
```

### 12.3 Error and per-field denial

```
GET /api/v1/data/snapshot?securities=AAPL%20US%20Equity&fields=PX_LAST,PX_BID     (user with an eod-only grant)
200 { "meta": { …, "tier": "eod", "entitlement": [{ "fieldId": "PX_LAST", "decision": "deny", "effectiveTier": "eod", "reason": "TIER_EOD" },
                                                     { "fieldId": "PX_BID", "decision": "deny", "effectiveTier": "eod", "reason": "TIER_EOD" }] },
      "results": [{ …, "fields": { "PX_LAST": null, "PX_BID": null }, "r": { "PX_LAST": "TIER_EOD", "PX_BID": "TIER_EOD" }, "tier": "eod", "st": "blank" }] }

POST /api/v1/functions/YAS/run  { "security": { "ref": "AAPL US Equity" } }
422 { "error": { "code": "FUNCTION_NOT_APPLICABLE", "message": "YAS applies to govt instruments; AAPL US Equity is equity", "traceId": "…", "retryable": false,
                 "details": { "assetClass": "equity", "applicable": ["govt"] } } }
```

---

## 13. Decision log (where the candidates disagreed)

| Topic | Chosen | Why (one line) |
| --- | --- | --- |
| Base paths | `/api/v1` + `/ws/v1` (B, C) not `/v1` + `/v1/stream` (A) | Fixed in ARCHITECTURE §15; one proxy prefix. |
| Real-time in the request model | `kind:'realtime'` is one variant that REST serves as a one-shot plant view and the SDK turns into `sub` (B's snapshot + C's sixth variant) — no subscription ticket (A) | ARCHITECTURE §6.4 rule 5 evaluates on `sub`; a ticket adds a second cache of the same decision. |
| Security addressing | `{ id } \| { ref } \| { formula }` (A's two forms + B/C's formula) not seven typed forms (B, C) | `core/ids/securityRef.ts` already parses every identifier syntax from one string; typed forms duplicate the grammar on the wire. |
| Reference field values | primitives + `r`/`fts`/`fprov` side maps (A, ARCHITECTURE WS) not per-field objects `{v, r, p, ts}` (B, C) | Same encoding as the WS frames; a grid cell does not care which surface fed it. |
| Meta | ARCHITECTURE `PayloadMeta` shape everywhere, `Meta` = same minus `resultId` | One meta means one provenance panel, one staleness badge, one CSV header. |
| Historical adjustment | `unadjusted \| price \| total_return` (B) not `none/split/split_div/total_return` (A, C) | BRIEF fixes three policies (DATA_MODEL §20). |
| Error codes | B's specific codes with A's HTTP mapping; `426 PROTOCOL_VERSION` from C | A screen footer needs a code it can translate; `NOT_FOUND` alone cannot say "ambiguous". |
| Sessions | supersede with `4003` (A, B) not "restricted" mode (C); dev password + optional WebAuthn (all) | ARCHITECTURE §15. |
| CSRF | `SameSite=Strict` + `x-requested-with: terminal` (B) | Cheapest defence that also blocks form posts; bearer clients unaffected. |
| Export on partial denial | whole export fails `403` (ARCHITECTURE §10 rule 2, C) not empty cells (A) | A CSV with silent blanks is exactly the audit finding ENTL-01 warns about. |
| CSV attribution | leading `#` comment lines + headers (B's header line, C's headers) | Licence attribution must travel with the file, not only the HTTP response. |
| Quotas | C's defaults (500 / 2 M / 2 000) enforced for api sessions, reported for web (ARCHITECTURE §10 rule 8) | API-06 is about programmatic use; a PM's desk should not hit a datapoint quota while watching a grid. |
| Search response | B's `matched` ranges + A's `insertText`/`matchedOn` | Highlighting and GO text are both needed by `<Autocomplete>`. |
| Universe snapshot | B's tuple arrays with numeric ids | ≈ 45 k rows must load in one frame; tuples are 4× smaller than objects. |
| Workspace layout | B's shape with `schema` version and panel ids `p1..p8`; `version` row counter with `409` (A, C) | Matches `workspaces.layout` comment in DATA_MODEL §12. |
| Messaging | REST send with `clientMsgId` idempotency (A) + WS `room:` delivery (B, ARCHITECTURE) | Hash chain is assigned by the DB trigger; REST gives the sender the `hash` synchronously. |
| Ticks on the wire | `TickRow` with `f` map + FEED-05 triple (C's timestamps, B's flat columns merged) | One tick shape for every `kind` without twenty nullable columns. |
| SDK shape | namespaced `TerminalClient` (`ref`, `fn`, `data`, …) matching ARCHITECTURE §5 (`sdk.ref.resolve`, `sdk.fn.run`) | The lifecycle already names these calls. |

## 14. Open questions (not resolvable from the inputs)

1. **Login name.** The task brief says "username + password"; `users` has only `email`. This document
   uses the email as the username (`LoginRequest.email`). If a separate short username is wanted it is one
   nullable column plus a second unique index — no wire change beyond accepting `username`.
2. **Where `n:`/`c:`/`e:`/`sys:` field ids live.** Treating them as dictionary entries with
   `assetClasses: []` keeps `FIELD_UNKNOWN` uniform but adds ≈ 30 non-instrument fields to `GET /fields`;
   the alternative (a separate `SubjectFields` table in `wire/ws.ts`) needs a second validation path.
3. **13F holders.** BRIEF says "13F where feasible"; no 13F fixture exists, so `/holders/:id` is specified
   over `etf_holdings` with `holderKind:'13f'` reserved. Whether SEC full-text-search being blocked makes
   13F ingestion infeasible in v1 is a PROVIDERS.md decision.
4. **Web-session quota enforcement.** Quotas are enforced only for bearer sessions (ARCHITECTURE §10
   rule 8). If a firm contract requires per-seat datapoint caps on display use, the switch is
   `quota_limits`-driven and the error path already exists; the default is left off.
5. **`/results/:resultId` for another user.** The re-run under the viewer's entitlements uses the cached
   `meta.asOf`; for live-plant values that means the viewer sees a *current* snapshot, not the sender's
   moment. MSG-04 says "render live … within their own entitlements", which this satisfies, but a
   "frozen share" variant (store the sender's payload with its entitlement mask) may be wanted for compliance review.
6. **Multi-window (TERM-10).** `WorkspaceLayout.windows` is carried and persisted; whether a second OS
   window opens its own WS (counting against `maxSubscriptions`) or shares via `BroadcastChannel` is a
   web-client decision outside this contract.
