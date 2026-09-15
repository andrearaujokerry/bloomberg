# API — REST routes, WebSocket protocol, auth, errors, field dictionary, quotas, export

All schemas below live in `packages/sdk/src/wire/*.ts` and are the **only** definition of the wire:
the server validates requests with them, serialises responses through them, and the web client
consumes them through `@terminal/sdk` (API-05). Base path `/v1`. JSON everywhere except CSV export
and `/metrics`.

---

## 1. Principles

| Rule | Detail |
| --- | --- |
| One request model (API-02) | Reference, historical, intraday, tick and real-time reads are all `DataRequest` (§4). Real-time returns a ticket that the WS `sub` message consumes; the fields, instruments and as-of semantics are identical. |
| Explicit as-of | Every read accepts `asOf: {validAt?, knownAt?}`; defaults are server `now`. Responses echo the effective values in `meta`. |
| Numbers carry meta | Every response has `meta: { traceId, validAt, knownAt, staleness?, provenance[], entitlement, adjustments? }`. |
| Entitlement before data | The evaluator runs before repositories; denied fields come back `null` with `reasons[field]`. |
| Versioning | Path `/v1`; header `x-protocol-version: 1`; server accepts protocol N and N−1 (OPS-02). Client sends `x-client-version: <semver>`; `hello` on WS returns `minClientVersion`. |
| Trace | `x-trace-id` request header optional; always returned. |
| Pagination | Cursor-based: `{ cursor?: string, limit?: number }` → `{ items, nextCursor? }`. |

---

## 2. Auth and session model (SEC-01/02/03, ENTL-03)

| Route | Method | Request (zod) | Response (zod) |
| --- | --- | --- | --- |
| `/v1/auth/login` | POST | `{ email: z.string().email(), password: z.string().min(12), clientKind: z.enum(['web','api']) }` | `200 { session: Session, mfaRequired: boolean, webauthnOptions?: PublicKeyCredentialRequestOptionsJSON }` sets cookie `tsid` (HttpOnly, Secure, SameSite=Strict) for `web`; returns `token` for `api` (shown once). |
| `/v1/auth/webauthn/register/options` | POST | `{}` (authenticated) | `PublicKeyCredentialCreationOptionsJSON` |
| `/v1/auth/webauthn/register/verify` | POST | `{ credential: RegistrationResponseJSON }` | `{ credentialId: string }` |
| `/v1/auth/webauthn/verify` | POST | `{ credential: AuthenticationResponseJSON }` | `{ session: Session }` (marks `mfa_verified`) |
| `/v1/auth/logout` | POST | `{}` | `204` |
| `/v1/auth/session` | GET | — | `Session` |
| `/v1/auth/sessions` | GET | — | `{ items: SessionSummary[] }` (own sessions; admin: any user) |

```ts
export const Session = z.object({
  sessionId: z.string().uuid(), userId: z.number().int(), firmId: z.number().int(),
  displayName: z.string(), role: z.enum(['user','admin','compliance','dataops','helpdesk']),
  mfaVerified: z.boolean(), expiresAt: z.string().datetime(),
  entitlementSummary: z.object({ defaultTier: z.enum(['realtime','delayed','eod']), exportAllowed: z.boolean(), apiAllowed: z.boolean() }),
  quotas: z.object({ dailyUniqueInstruments: z.number(), monthlyDataPoints: z.number(), concurrentSubscriptions: z.number() }),
});
```

Rules: one active session per user unless `firms.allow_concurrent_sessions`; a new login revokes
older sessions (`revoke_reason='superseded'`), and any open WS receives `bye {code:4409}`. Requests
with a revoked token get `401 SESSION_REVOKED`. Sessions expire after 12 h idle (web) / 30 d (api).
Password hashing: `crypto.scrypt` (N=2^15, r=8, p=1). WebAuthn: `@simplewebauthn/server`-compatible
JSON shapes; MFA is required when `firms.policy.mfaRequired` (default true for `api` sessions).

---

## 3. Error envelope

```ts
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode, message: z.string(), traceId: z.string().uuid(),
    retryable: z.boolean(), details: z.record(z.unknown()).optional(),
  }),
});
```

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | zod parse failure; `details.issues` |
| `UNAUTHENTICATED` / `SESSION_REVOKED` / `MFA_REQUIRED` | 401 | |
| `FORBIDDEN` | 403 | role / tenant |
| `ENTL_DENIED` | 403 | whole request denied (no entitled field) — partial denials are per-field reasons, HTTP 200 |
| `QUOTA_EXCEEDED` | 429 | `details: { quota, limit, used, resetAt }` |
| `RATE_LIMITED` | 429 | per-user route rate limit |
| `NOT_FOUND` / `UNRESOLVED_SECURITY` | 404 | `details.candidates[]` for ambiguous refs |
| `AMBIGUOUS_SECURITY` | 409 | multiple matches; `details.candidates[]` |
| `PROVIDER_UNAVAILABLE` | 503 | live fetch required and failed; `retryable: true` |
| `REPLAY_MISS` | 500 (test only) | fixture missing in replay mode |
| `INTERNAL` | 500 | |

Per-field reason codes (`ReasonCode`, shared with WS): `ENTL_TIER_DOWNGRADE`, `ENTL_FIELD_DENIED`,
`ENTL_SOURCE_NOT_LICENSED`, `ENTL_USAGE_TYPE_DENIED`, `ENTL_QUOTA_EXCEEDED`, `NO_CONSENSUS_SOURCE`,
`NOT_IN_WEDGE`, `SOURCE_STALE`, `SOURCE_UNAVAILABLE`, `NOT_APPLICABLE_ASSET_CLASS`, `NO_DATA_AS_OF`,
`PENDING_REVIEW` (data-ops exception open), `SLOW_CONSUMER`, `PLANT_OVERLOAD`, `CONCURRENT_SESSION`.

---

## 4. Common types and the unified `DataRequest` (API-02)

```ts
// packages/sdk/src/wire/common.ts
export const InstrumentRef = z.union([
  z.object({ id: z.number().int() }),
  z.object({ ref: z.string().min(1) }),               // 'AAPL US Equity', 'SPX Index', '912797VE4 Govt', '/isin/US0378331005', '/figi/BBG000B9XRY4'
]);
export const AsOf = z.object({ validAt: z.string().datetime().optional(), knownAt: z.string().datetime().optional() });
export const Tier = z.enum(['realtime','delayed','eod']);
export const Staleness = z.object({ state: z.enum(['live','stale','closed','eod','unknown']), ageMs: z.number(), tier: Tier, delayMin: z.number(), expectedIntervalMs: z.number() });
export const ProvenanceRef = z.object({ id: z.number().int(), sourceId: z.string(), endpoint: z.string(), fetchedAt: z.string().datetime(), sourceTs: z.string().datetime().nullable(), attribution: z.string().optional() });
export const EntitlementInfo = z.object({ effectiveTier: Tier, usage: z.enum(['display','export','api']), downgrades: z.array(z.object({ code: ReasonCode, message: z.string() })) });
export const Meta = z.object({
  traceId: z.string().uuid(), validAt: z.string().datetime(), knownAt: z.string().datetime(), servedAt: z.string().datetime(),
  staleness: Staleness.optional(), provenance: z.array(ProvenanceRef), entitlement: EntitlementInfo,
  adjustments: z.array(z.object({ beforeDate: z.string(), priceFactor: z.number(), volumeFactor: z.number(), kind: z.enum(['split','dividend']) })).optional(),
  unavailable: z.array(z.object({ field: z.string(), reason: ReasonCode, message: z.string().optional() })),
  engineVersion: z.string().optional(), inputsHash: z.string().optional(),   // ANAL-08
});
export const Periodicity = z.enum(['1m','5m','15m','1h','D','W','M','Q','Y']);
export const AdjustPolicy = z.enum(['unadjusted','split','split_dividend','total_return']);

// packages/sdk/src/wire/data-request.ts
export const DataRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reference'),  instruments: z.array(InstrumentRef).max(500), fields: z.array(FieldId).max(200), asOf: AsOf.optional() }),
  z.object({ kind: z.literal('historical'), instruments: z.array(InstrumentRef).max(50),  fields: z.array(FieldId).max(20),
             range: z.object({ start: z.string().date(), end: z.string().date() }), periodicity: Periodicity.extract(['D','W','M','Q','Y']).default('D'),
             adjustment: AdjustPolicy.default('split_dividend'), asOf: AsOf.optional(), calendarAlign: z.enum(['union','intersection','primary']).default('primary') }),
  z.object({ kind: z.literal('intraday'),   instruments: z.array(InstrumentRef).max(20),  fields: z.array(FieldId).max(10),
             range: z.object({ start: z.string().datetime(), end: z.string().datetime() }), periodicity: Periodicity.extract(['1m','5m','15m','1h']).default('1m'), asOf: AsOf.optional() }),
  z.object({ kind: z.literal('tick'),       instruments: z.array(InstrumentRef).max(5),   fields: z.array(FieldId).max(10),
             range: z.object({ start: z.string().datetime(), end: z.string().datetime() }), kinds: z.array(z.enum(['trade','quote','summary'])).default(['trade','quote']), limit: z.number().int().max(100000).default(10000) }),
  z.object({ kind: z.literal('realtime'),   instruments: z.array(InstrumentRef).max(10000), fields: z.array(FieldId).max(50), tier: Tier.default('delayed'), conflationMs: z.number().int().min(50).max(60000).default(250) }),
]);

export const SeriesPoint = z.tuple([z.string(), z.number().nullable()]);         // [isoDateOrTs, value]
export const DataResult = z.object({
  request: InstrumentRef, instrument: InstrumentSummary.nullable(),                // resolved as-of
  fields: z.record(FieldId, z.union([z.number(), z.string(), z.boolean(), z.null()])).optional(),      // reference
  series: z.record(FieldId, z.array(SeriesPoint)).optional(),                     // historical / intraday
  ticks: z.array(TickRow).optional(),                                             // tick
  reasons: z.record(FieldId, ReasonCode).optional(),                              // per-field blanks
  staleness: Staleness.optional(), provenance: z.array(z.number().int()),         // ids into meta.provenance
  error: z.object({ code: ErrorCode, message: z.string() }).optional(),
});
export const DataResponse = z.object({ meta: Meta, results: z.array(DataResult), subscriptionTicket: z.string().optional() /* realtime only */ });
```

`POST /v1/data` → `DataResponse`. For `kind:'realtime'` the server evaluates entitlements per
instrument × field × tier (one `access_log` row per triple, purpose `'data.realtime'`), reserves
quota, and returns `subscriptionTicket` (opaque, 60 s TTL) plus the per-subject `subok` preview in
`results[].reasons`; the WS `sub` message carries the ticket so the WS path performs no second
evaluation (same decision object, cached by ticket).

---

## 5. REST routes

### 5.1 Reference and resolution

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `/v1/resolve` | POST | `{ refs: z.array(z.string()).max(200), asOf?: AsOf, context?: { panelSecurityId?: number } }` | `{ meta, results: [{ ref, instrument: InstrumentSummary \| null, candidates: InstrumentSummary[], error? }] }` |
| `/v1/instruments/:id` | GET | query `validAt?, knownAt?` | `{ meta, instrument: Instrument, issue: Issue, issuer: Issuer, listings: Listing[], mdLines: MdLine[], terms: Terms, classifications: [{scheme, code, name}] }` |
| `/v1/instruments/:id/identifiers` | GET | `validAt?, knownAt?` | `{ meta, identifiers: [{scheme, value, qualifier, isPrimary, validFrom, validTo}] }` |
| `/v1/instruments/:id/versions` | GET | `table?: 'instruments'\|'govt_terms'\|…` | `{ meta, versions: [{versionId, validFrom, validTo, txFrom, txTo, provenance, data}] }` (audit view of the bitemporal history) |
| `/v1/issuers/:id` | GET | as-of | `{ meta, issuer, instruments: InstrumentSummary[], people: Person[], relations: Relation[] }` |
| `/v1/calendars/:calendarId` | GET | `from, to` | `{ holidays: [{day, name, kind, closeTime?}], sessions: [...] }` |
| `/v1/indices/:instrumentId/members` | GET | `asOfDate?, validAt?, knownAt?` | `{ meta, asOfDate, members: [{ instrument, weight, shares, marketValue }] }` |
| `/v1/instruments/:id/corporate-actions` | GET | as-of, `from?, to?` | `{ meta, actions: CorporateAction[] }` |

```ts
export const InstrumentSummary = z.object({
  instrumentId: z.number().int(), display: z.string(),            // 'AAPL US Equity'
  ticker: z.string(), exchCode: z.string(), marketSector: MarketSector, assetClass: AssetClass,
  name: z.string(), currency: z.string().length(3), compositeFigi: z.string().optional(), status: z.string(),
});
```

### 5.2 Search (TERM-02)

`GET /v1/search/autocomplete?q=<text>&limit=12&panelSecurityId=&panelFunction=` →

```ts
export const AutocompleteItem = z.object({
  kind: z.enum(['instrument','function','person','topic','command']),
  id: z.string(),                       // instrumentId | function code | personId | topic code | full command text
  primary: z.string(),                  // 'AAPL US Equity' | 'GP'
  secondary: z.string(),                // 'Apple Inc — Common Stock, NASDAQ GS' | 'Price graph'
  score: z.number(), matchedOn: z.enum(['code','ticker','name','isin','cusip','figi','alias','trigram']),
  insertText: z.string(),               // what GO would execute
});
export const AutocompleteResponse = z.object({ meta: Meta.pick({traceId:true, servedAt:true}), items: z.array(AutocompleteItem), tookMs: z.number() });
```

`GET /v1/search/securities` (SECF) — `q, assetClass[], marketSector, exchCode, gicsSector, country, cursor, limit` → `{ items: InstrumentSummary[], nextCursor }`.

### 5.3 Functions (FUNC-01..04)

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `/v1/functions` | GET | — | `{ functions: FunctionManifestPublic[] }` (code, name, aliases, tier, assetClasses, paramsJsonSchema, help) |
| `/v1/functions/:code/resolve` | POST | `{ params: unknown /* validated by manifest.params */, asOf?: AsOf, panelId?: string, launchKind: z.enum(['launch','param_change','refresh']) }` | `FunctionPayload<T>` = `{ meta: Meta, code, params: T_params, data: T, subjects?: string[] /* WS subjects for live fields */, layoutHints? }` |
| `/v1/functions/:code/help` | GET | — | `{ code, name, summary, description, params: [{name, type, description, example}], keys: [{key, action}], fields: [{fieldId, definition}] }` |
| `/v1/usage/events` | POST | `{ events: z.array(UsageEvent).max(100) }` (client-side events: navigate, help press, param edits) | `202` |

Every `resolve` call writes one `usage_events` row (`event_kind = launchKind`) and its access-log rows.

### 5.4 Export (FUNC-03)

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `/v1/export/functions/:code.csv` | GET | query `params=<base64url JSON>`, `validAt`, `knownAt` (both required; the client passes the payload's `meta` values) | `text/csv; charset=utf-8`, RFC 4180, header row from `manifest.csv.columns`; headers `x-trace-id`, `x-as-of-valid`, `x-as-of-known`, `x-provenance: <comma-separated provenance ids>`, `x-engine-version`, `content-disposition: attachment; filename="<CODE>_<display>_<validAt>.csv"` |
| `/v1/export/data.csv` | POST | `DataRequest` (non-realtime) | same CSV conventions; one row per (instrument, date) for series |

Export runs the **same resolver and the same `toCsv`** as the screen with `usage:'export'`; denied
fields are empty cells and the response header `x-unavailable` lists `field:reason` pairs.

### 5.5 Fields (API-07)

`GET /v1/fields?category=&assetClass=&version=` → `{ version: '1.3.0', fields: FieldDef[] }`;
`GET /v1/fields/:id` → `FieldDef`; `GET /v1/fields/changelog` → `[{version, date, added[], deprecated[], removed[]}]`.

### 5.6 News (NEWS-01/02/07)

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `/v1/news` | GET | `q?, instrumentId?, issuerId?, topic?, feed?, kinds?[], from?, to?, cursor?, limit≤200` | `{ meta, items: NewsItem[], nextCursor }` — `q` uses `websearch_to_tsquery` with trigram fallback |
| `/v1/news/:id` | GET | — | `NewsItem & { links: [{entityKind, entityId, display, confidence, method}] }` |
| `/v1/news/top` | GET | `scope: 'all'\|'instrument'\|'topic', id?` | ranked headlines (ranker: recency × source weight × entity-link confidence × click-through from usage_events) |

### 5.7 Workspace, watchlists, portfolios, messaging, alerts, help

| Route | Method | Request → Response |
| --- | --- | --- |
| `/v1/workspace` | GET / PUT | `WorkspaceLayout` (CLIENT.md §6) with optimistic `version`; `409 WORKSPACE_VERSION_CONFLICT` returns the server copy |
| `/v1/watchlists` | GET / POST | list / `{ name, columns, sharedScope }` |
| `/v1/watchlists/:id` | GET / PUT / DELETE | |
| `/v1/watchlists/:id/items` | PUT | `{ items: [{instrumentId, position, note?}] }` (full replace) |
| `/v1/portfolios` | GET / POST | `{ name, baseCurrency, benchmarkInstrumentId? }` |
| `/v1/portfolios/:id/positions` | GET / PUT | `{ asOf, positions: [{ ref, quantity, costBasis?, costCurrency?, lotDate? }] }` |
| `/v1/portfolios/:id/positions/upload` | POST (multipart CSV) | `{ uploadId, rowCount, errorCount, errors: [{row, field, message}], status }` (PORT-01) |
| `/v1/rooms` | GET / POST | `{ kind, name?, memberUserIds[] }` |
| `/v1/rooms/:id/messages` | GET (cursor) / POST `{ clientMsgId, body, attachments[] }` | messages; POST returns `{ messageId, hash }`; policy checks (permitted counterparties, ethical walls) → `403 MSG_POLICY` |
| `/v1/directory/users?q=` | GET | verified directory `{ userId, displayName, firm, desk, role }` |
| `/v1/alerts` | GET / POST / PUT / DELETE | `Alert` |
| `/v1/help/tickets` | POST | `{ functionCode?, panelState, traceId? }` → `{ ticketId, roomId }` (TERM-09 second press opens a helpdesk room) |
| `/v1/quota` | GET | `{ dailyUniqueInstruments: {limit, used}, monthlyDataPoints: {limit, used}, concurrentSubscriptions: {limit, used} }` |

### 5.8 Admin / ops

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/admin/trace/:traceId` | GET | join of logs, access_log, provenance, usage_events for one trace (OPS-07) |
| `/v1/admin/declarations?month=YYYY-MM&sourceId=` | GET | usage declarations; `POST /generate` runs the query and stores rows (ENTL-06, DATA-02) |
| `/v1/admin/licences` | GET / PUT `:sourceId` | licence registry (dataops/admin roles) |
| `/v1/admin/exceptions` | GET / `POST /:id/resolve` | REF-10 exception queue |
| `/v1/admin/dq` | GET | open dq_events |
| `/v1/admin/ingest/runs?job=` | GET | scheduler history |
| `/v1/admin/compliance/reviews` | GET / POST `/:id` | message review queue (compliance role) |
| `/v1/admin/compliance/holds` | POST / DELETE | legal holds |
| `/v1/admin/compliance/export` | POST `{ roomIds?, userIds?, from, to }` | prompt production (REG-01): NDJSON with hash chain verification result |
| `/v1/health`, `/v1/status`, `/metrics` | GET | liveness; component status incl. provider staleness (OPS-04); Prometheus |

---

## 6. WebSocket protocol (BUS-01..08, ENTL-05)

Endpoint `wss://…/v1/stream`. Authentication: cookie (web) or first message `auth` (api). One
connection per session; a second connection for the same session closes the first with `4409`.
JSON text frames; every server frame validated by `sdk/wire/ws.ts` on the client.

```ts
// packages/sdk/src/wire/ws.ts
export const SubjectId = z.string().regex(/^(q|l|o|b1m|n|c|sys):[A-Za-z0-9_.:-]+$/);
//  q:<instrumentId>      composite quote        fields from QuoteFields
//  l:<mdLineId>          single market-data line quote (per-venue/per-provider view for QM); same fields as q:
//  o:<instrumentId>      option contract quote  (bid/ask/iv/greeks/oi)
//  b1m:<instrumentId>    in-progress 1-minute bar {BAR_TS, PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME, IS_FINAL}
//  n:<topicCode|inst:<id>|all>  headline stream  {NEWS_ID, HEADLINE, PUBLISHED_AT, SOURCE_ID, LINKS}
//  c:<curveId>           curve points as published
//  sys:status            plant/provider status

export const ClientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'),   token: z.string(), clientVersion: z.string(), protocol: z.literal(1) }),
  z.object({ t: z.literal('sub'),    id: z.string(), ticket: z.string().optional(),
             subjects: z.array(SubjectId).max(10000), fields: z.array(FieldId).max(50).optional(),
             conflationMs: z.number().int().min(50).max(60000).optional(), tier: Tier.optional() }),
  z.object({ t: z.literal('unsub'),  id: z.string(), subjects: z.array(SubjectId).optional() }),
  z.object({ t: z.literal('resync'), id: z.string(), subjects: z.array(z.object({ s: SubjectId, seq: z.number().int() })) }),
  z.object({ t: z.literal('ping'),   ts: z.number() }),
]);

export const FieldValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export const Ts = z.object({ src: z.string().datetime().nullable(), cap: z.string().datetime(), pub: z.string().datetime() }); // FEED-05

export const ServerMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), sessionId: z.string().uuid(), protocol: z.literal(1), serverTime: z.string().datetime(),
             heartbeatMs: z.number(), maxSubscriptions: z.number(), minClientVersion: z.string(), defaultConflationMs: z.number() }),
  z.object({ t: z.literal('subok'), id: z.string(),
             subjects: z.array(z.object({ s: SubjectId, tier: Tier, seq: z.number().int(), conflationMs: z.number(),
                                          fields: z.array(FieldId), denied: z.record(FieldId, ReasonCode).optional(),
                                          downgrade: z.object({ code: ReasonCode, message: z.string() }).optional() })),
             rejected: z.array(z.object({ s: SubjectId, code: ReasonCode, message: z.string() })), traceId: z.string().uuid() }),
  z.object({ t: z.literal('snap'),  s: SubjectId, seq: z.number().int(), tier: Tier, st: Staleness, ts: Ts,
             f: z.record(FieldId, FieldValue), r: z.record(FieldId, ReasonCode).optional(), pv: z.number().int() /* provenance id */ }),
  z.object({ t: z.literal('delta'), s: SubjectId, seq: z.number().int(), st: Staleness, ts: Ts,
             f: z.record(FieldId, FieldValue), r: z.record(FieldId, ReasonCode).optional(), pv: z.number().int(), n: z.number().int() /* updates conflated into this delta */ }),
  z.object({ t: z.literal('downgrade'), s: SubjectId.optional(), code: ReasonCode, conflationMs: z.number().optional(),
             shed: z.array(SubjectId).optional(), message: z.string() }),
  z.object({ t: z.literal('unsubok'), id: z.string(), subjects: z.array(SubjectId) }),
  z.object({ t: z.literal('pong'), ts: z.number(), serverTs: z.string().datetime() }),
  z.object({ t: z.literal('err'), ref: z.string().optional(), code: ErrorCode, message: z.string(), traceId: z.string().uuid() }),
  z.object({ t: z.literal('bye'), code: z.number().int(), reason: z.string() }),
]);
```

### 6.1 Sequencing and snapshot/delta guarantees

- The plant keeps `seq` per subject, incremented on every applied update (`plant/ticker-plant.ts`).
- On `sub`, the server sends `subok` then one `snap` per subject with the current full field set and its `seq`.
- Every `delta` carries the subject `seq` of the **latest** update it contains. Conflation may skip
  intermediate seqs (`n` says how many were coalesced) but `seq` is strictly increasing per subject
  on the wire. A client that sees `seq ≤ lastSeq` (impossible unless server restart) sends `resync`.
- **Resync/reconnect (BUS-07):** on reconnect the client sends `sub` again (with the last known
  `seq` per subject in a `resync`); the server always answers with a fresh `snap`, never by
  replaying deltas, so there is no gap and no double application: the client replaces its state
  wholesale at the snapshot's `seq` and discards any queued delta with a lower `seq`.
- The client applies deltas as a field-wise merge; `null` with a reason in `r` blanks the field (ENTL-05).

### 6.2 Conflation (BUS-03)

`plant/conflator.ts` per (connection, subject): a dirty-field map. `apply(update)` overwrites
per-field values (so the latest value is always what is flushed). A timer at `conflationMs`
(default 250; `sub` may request ≥ 50; tier `eod` forces ≥ 60000) flushes all dirty subjects for the
connection in one batch frame (`[delta, delta, …]` arrays are allowed on the wire: the server may
send a JSON array of `ServerMsg`). `st`/`ts` of a delta are those of the latest update. Guarantee
tested in TESTING.md §5: for any input sequence, the last flushed value of every field equals the
last applied value, and no flush contains a value older than a previously flushed one.

### 6.3 Slow consumer and overload (BUS-04, NFR-02)

Watch `socket.bufferedAmount` every 250 ms:

| Condition | Action | Message |
| --- | --- | --- |
| > 1 MiB | conflation for the connection widened to `max(current, 1000)` ms | `downgrade {code:'SLOW_CONSUMER', conflationMs:1000}` |
| > 4 MiB for 10 s | shed non-essential subjects (`n:*`, `b1m:*`, `o:*`), keep `q:*` | `downgrade {code:'SLOW_CONSUMER', shed:[…]}` |
| > 16 MiB or no `pong` for 3 heartbeats | close | `bye {code:4008, reason:'SLOW_CONSUMER'}` |
| plant apply p99 > 5 ms over 10 s (overload) | all connections' conflation floor raised to 1000 ms; `q:*` last price preserved | `downgrade {code:'PLANT_OVERLOAD'}` |

Never silent: every action emits a `downgrade` frame and a `dq_events`/metrics record.

### 6.4 Entitlement on subscribe (ENTL-05)

`sub` without a ticket triggers the evaluator (same code path as REST). Per subject: effective
tier (`delayed` default; `eod` if no grant; `realtime` never attainable from v1 sources), denied
fields listed in `denied` with reason codes, and `downgrade` when the requested tier exceeds the
effective one. `rejected` lists subjects the user may not see at all (`ENTL_SOURCE_NOT_LICENSED`)
or over quota (`ENTL_QUOTA_EXCEEDED`). Every decision is access-logged with purpose `'ws.sub'`.

### 6.5 Limits

`maxSubscriptions` per connection = `quota_limits.concurrent_subscriptions` (default 10,000; BUS-08).
Heartbeat 15 s. Frame size limit 1 MiB. Batch frames ≤ 500 deltas.

### 6.6 Example

```json
→ {"t":"sub","id":"w1","subjects":["q:42","q:57"],"fields":["PX_LAST","CHG_PCT_1D","PX_BID","PX_ASK","PX_VOLUME"],"conflationMs":250}
← {"t":"subok","id":"w1","subjects":[{"s":"q:42","tier":"delayed","seq":15972883317,"conflationMs":250,"fields":["PX_LAST","CHG_PCT_1D","PX_BID","PX_ASK","PX_VOLUME"],
     "downgrade":{"code":"ENTL_TIER_DOWNGRADE","message":"realtime not licensed for cboe; serving delayed (15 min)"}}],"rejected":[],"traceId":"…"}
← {"t":"snap","s":"q:42","seq":15972883317,"tier":"delayed","st":{"state":"live","ageMs":4100,"tier":"delayed","delayMin":15,"expectedIntervalMs":10000},
     "ts":{"src":"2026-09-15T14:26:26-04:00","cap":"2026-09-15T18:41:28Z","pub":"2026-09-15T18:41:28.031Z"},
     "f":{"PX_LAST":330.27,"CHG_PCT_1D":-0.8436,"PX_BID":330.25,"PX_ASK":330.28,"PX_VOLUME":16591786},"pv":991}
← [{"t":"delta","s":"q:42","seq":15972883402,"st":{…},"ts":{…},"f":{"PX_LAST":330.31,"PX_VOLUME":16601001},"pv":992,"n":3}]
```

---

## 7. Field dictionary format (API-07)

```ts
// packages/sdk/src/fields/types.ts
export interface FieldDef {
  id: FieldId;                          // 'PX_LAST'
  name: string;                         // 'Last price'
  definition: string;                   // one paragraph, unambiguous
  type: 'number'|'string'|'date'|'datetime'|'boolean'|'enum';
  unit: 'price'|'pct'|'bp'|'shares'|'contracts'|'ccy'|'ratio'|'years'|'days'|'count'|'text'|'date'|'datetime'|'enum';
  decimals?: number; enumValues?: string[];
  category: 'price'|'reference'|'fundamental'|'econ'|'news'|'analytic'|'derived'|'portfolio';
  assetClasses: AssetClass[];
  source: { assetClass: AssetClass|'*'; sourceId: string; endpoint: string; providerField: string }[];   // e.g. cboe delayed_quote 'current_price'
  updateFrequency: 'tick'|'1m'|'daily'|'weekly'|'monthly'|'quarterly'|'annual'|'static';
  pit: boolean;                         // true = value depends on knownAt (fundamentals, econ)
  example: { ref: string; value: number|string; asOf: string };
  introduced: string; deprecated?: { version: string; replacement?: FieldId; removeAfter: string };
}
```

Excerpt of `fields/dictionary.ts` (full list ≈ 220 fields):

| id | type/unit | category | source (equity) | frequency | pit |
| --- | --- | --- | --- | --- | --- |
| `PX_LAST` | number/price | price | cboe `delayed_quote.current_price`; yahoo `meta.regularMarketPrice` | tick | no |
| `PX_BID`, `PX_ASK`, `BID_SIZE`, `ASK_SIZE` | price/shares | price | cboe | tick | no |
| `PX_OPEN`,`PX_HIGH`,`PX_LOW`,`PX_CLOSE_1D`,`PX_VOLUME` | price | price | cboe (`open/high/low/prev_day_close/volume`) | tick | no |
| `CHG_NET_1D`,`CHG_PCT_1D` | price/pct | derived | computed from `PX_LAST − PX_CLOSE_1D` | tick | no |
| `LAST_TRADE_TIME`,`SESSION_STATE`,`STALENESS` | datetime/enum | price | plant | tick | no |
| `IVOL_30D` | pct | analytic | cboe `iv30` | tick | no |
| `PX_HIST_OPEN/HIGH/LOW/CLOSE`, `PX_HIST_VOLUME`, `PX_ADJ_CLOSE`, `TOT_RETURN_INDEX` | price | price | yahoo chart v8 (`indicators.quote`), stooq fallback | daily | no (adjustment policy param) |
| `NAME`,`TICKER`,`EXCH_CODE`,`ID_ISIN`,`ID_CUSIP`,`ID_SEDOL`,`ID_BB_GLOBAL`,`ID_BB_GLOBAL_COMPOSITE`,`ID_BB_GLOBAL_SHARE_CLASS`,`ID_LEI`,`ID_CIK`,`CRNCY`,`SECURITY_TYP`,`MARKET_SECTOR_DES`,`GICS_SECTOR_NAME`,`GICS_SUB_INDUSTRY_NAME`,`SIC_CODE`,`COUNTRY_OF_INCORP`,`FISCAL_YEAR_END` | text | reference | openfigi, sec_edgar, wikipedia (GICS) | static/daily | yes (valid/known) |
| `SALES_REV_TURN`,`GROSS_PROFIT`,`IS_OPER_INC`,`NET_INCOME`,`IS_EPS_DIL`,`BS_TOT_ASSET`,`BS_TOT_LIAB2`,`TOTAL_EQUITY`,`CF_CASH_FROM_OPER`,`CF_CAP_EXPEND`,`FREE_CASH_FLOW`,`DVD_SH_12M`,`EQY_SH_OUT`,`PE_RATIO`,`PX_TO_BOOK_RATIO`,`EV_TO_EBITDA`,`RETURN_COM_EQY` | number | fundamental/derived | sec_edgar companyfacts → `xbrl_concept_map` | quarterly | **yes** |
| `MTY_YEARS`,`CPN`,`CPN_FREQ`,`DAY_CNT_DES`,`MATURITY`,`ISSUE_DT`,`YLD_YTM_MID`,`DUR_MID`,`DUR_ADJ_MID`,`CONVEXITY_MID`,`DV01`,`PX_DIRTY_MID`,`ACCRUED` | number | reference/analytic (govt) | ustreasury, core analytics | daily | terms yes |
| `OPT_STRIKE_PX`,`OPT_EXPIRE_DT`,`OPT_PUT_CALL`,`OPT_UNDL_TICKER`,`OPT_CONT_SIZE`,`OPEN_INT`,`IVOL_MID`,`DELTA_MID`,`GAMMA_MID`,`VEGA_MID`,`THETA_MID`,`RHO_MID`,`THEO_PX` | number | reference/analytic (option) | cboe options | 1m | no |
| `ECO_RELEASE_DT`,`ECO_ACTUAL`,`ECO_PRIOR`,`ECO_REVISED_PRIOR`,`ECO_SURVEY` | number/date | econ | fred, bls, nyfed; `ECO_SURVEY` always unavailable `NO_CONSENSUS_SOURCE` | per release | **yes** |
| `SHORT_INT`,`SHORT_INT_RATIO` | shares/ratio | reference | finra | twice-monthly | no |
| `IDX_MEMBER_WEIGHT`,`IDX_MEMBER_SINCE` | ratio/date | reference | sec_nport | monthly | yes |

Deprecation policy: a field is marked `deprecated` for ≥ 2 minor versions before removal; the
server keeps serving it with header `x-deprecated-fields`; `GET /v1/fields/changelog` documents the change.
`dictionaryVersion` is semver; the web build pins the version it was built against and refuses to
start on a major mismatch (`hello.minClientVersion`).

---

## 8. Quotas (API-06)

Enforced in `entitlements/quotas.ts` on every `/v1/data`, function resolve, export and WS `sub`:

| Quota | Default | Counting rule | Error |
| --- | --- | --- | --- |
| Daily unique instruments | 5,000 / user | `quota_instruments_seen` insert-if-absent per (user, day, instrument) | `429 QUOTA_EXCEEDED {quota:'dailyUniqueInstruments'}` |
| Monthly data points | 10,000,000 / user | series points + reference cells + WS deltas × fields (WS counted at flush) | same, `quota:'monthlyDataPoints'` |
| Concurrent subscriptions | 10,000 / session | live count in plant | WS `rejected` with `ENTL_QUOTA_EXCEEDED`; REST `429` |
| Route rate limits | 20 req/s burst 50 (data), 10 req/s (search), 2 req/s (export) | token bucket per session | `429 RATE_LIMITED` |

`GET /v1/quota` shows usage; limits are per user or firm rows in `quota_limits`.

---

## 9. SDK surface (`@terminal/sdk`)

```ts
const api = createClient({ baseUrl, token?, fetch?, onTrace? });
await api.resolve(['AAPL US Equity']);
await api.data({ kind:'historical', instruments:[{ref:'AAPL US Equity'}], fields:['PX_HIST_CLOSE'], range:{start:'2020-01-01', end:'2020-12-31'}, adjustment:'split' });
const fn = await api.functions.resolve('DES', { security: 'AAPL US Equity' });
const ws = api.stream({ onDowngrade, onStatus });
const sub = ws.subscribe(['q:42'], ['PX_LAST','CHG_PCT_1D'], { conflationMs: 250 });
sub.on('update', (s, fields, meta) => …);      // meta: { seq, st, ts, reasons }
ws.close();
```

The web client uses exactly this client; there is no second HTTP layer in `packages/web`.
