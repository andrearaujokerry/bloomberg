## 1. Adapter contract

Every byte that becomes a number on a screen enters the system through exactly one adapter, and every
adapter obeys the same five obligations from BRIEF §2: record into the replay store (FEED-08, QA-02),
stamp provenance (DATA-10), carry a `licence_registry` row (DATA-09), be rate-limited and cache-aware,
and publish enough metadata for the staleness renderer (TERM-12).

### 1.1 `packages/server/src/providers/types.ts`

```ts
import type { NormalisedUpdate } from '@terminal/core/types/quote';
import type { Clock } from '@terminal/core/time/clock';

/** A provider adapter id. Every ProviderId is also a licence_registry.source_id; the reverse is not
 *  true — 'internal.derived', 'internal.user' and 'wiki.sp500' are source_ids with no HTTP adapter. */
export type ProviderId =
  | 'cboe.quotes' | 'cboe.options' | 'cboe.symbolBook' | 'cboe.euIndices'
  | 'yahoo.chart' | 'yahoo.search'
  | 'openfigi.mapping'
  | 'sec.tickers' | 'sec.submissions' | 'sec.companyfacts' | 'sec.frames' | 'sec.atom' | 'sec.archives'
  | 'fred.csv' | 'fred.calendar'
  | 'nyfed.rates' | 'fed.h15' | 'fed.rss' | 'fed.fomc'
  | 'treasury.yieldcurve' | 'treasury.bills'
  | 'bls.timeseries' | 'bls.schedule'
  | 'worldbank' | 'imf.datamapper'
  | 'frankfurter' | 'finra.shortInterest' | 'bbg.rss' | 'coingecko.simple' | 'ssga.holdings';

/** One raw provider exchange. Immutable; the only thing the replay store persists and the only input
 *  to normalise(). Shape extends ARCHITECTURE §6.2 `{ url, status, headers, body, capturedAt, sha256 }`. */
export interface RawRecord {
  providerId: ProviderId;
  method: 'GET' | 'POST';
  url: string;                          // canonical URL (scheme+host+path+sorted query), post-redirect
  requestKey: string;                   // replayStore.requestKey(...) — provenance.request_key
  status: number;                       // 200 | 304 | …
  headers: Readonly<Record<string, string>>;   // lower-cased names; etag, last-modified, content-type kept
  body: Buffer;                         // exact bytes; never a parsed object
  capturedAt: number;                   // epoch ms — FEED-05 'cap' and provenance.captured_at
  sha256: string;                       // lower-case hex of body — provenance.response_sha256
  requestHash: string;                  // lower-case hex sha256(method + url + body) — provenance.request_hash
  origin: 'live' | 'cache' | 'replay';  // 'cache' = 304 revalidation or TTL hit, body served from store
}

/** What a normaliser returns: plant-bound updates plus typed rows bound for Postgres.
 *  `Rows` is a per-adapter record of arrays; an adapter that only ticks the plant sets Rows = {}. */
export interface Normalised<Rows> {
  updates: NormalisedUpdate[];          // plant.apply() input, one per md line touched
  rows: Rows;                           // typed row objects, column names identical to DATA_MODEL.md
  sourceTs: Date | null;                // provenance.source_ts (provider-published instant, 'src')
  problems: NormaliseProblem[];         // non-fatal: unknown symbol, dropped field, schema drift
}

export interface NormaliseProblem {
  kind: 'parse_error' | 'unknown_symbol' | 'field_dropped' | 'schema_drift' | 'out_of_range';
  detail: string;
  path?: string;                        // JSON pointer into the payload, e.g. '/data/options/17/iv'
}

/** Everything normalise() is allowed to know. No db handle, no network, no Date.now(). */
export interface NormaliseContext {
  provenanceId: number;                 // from providers/provenance.ts, inserted before normalise()
  capturedAt: number;                   // = raw.capturedAt; the only clock reading a normaliser sees
  /** md lines already resolved for this source: key = md_lines.provider_symbol. */
  lines: ReadonlyMap<string, {
    mdLineId: number; instrumentId: number; assetClass: AssetClass;
    tier: Tier; intrinsicDelayMin: number; expectedIntervalMs: number; priority: number;
  }>;
  /** instrument ids for symbols the adapter may mint rows for (option contracts, fx pairs). */
  resolveInstrument?(key: { scheme: IdScheme; value: string; qualifier: string }): number | null;
}

export interface ProviderAdapter<Req, Rows> {
  readonly id: ProviderId;
  readonly sourceId: string;            // licence_registry.source_id — equal to `id` for every v1 adapter
  readonly adapterVersion: string;      // provenance.adapter_version, e.g. 'cboe/1.0.0'
  /** Build URL + headers and go through http.ts. Never parses. Never writes. */
  fetch(http: HttpClient, req: Req): Promise<RawRecord>;
  /** Pure: (RawRecord, NormaliseContext) → rows. Same input ⇒ byte-identical output, forever. */
  normalise(raw: RawRecord, ctx: NormaliseContext): Normalised<Rows>;
}
```

`packages/server/src/providers/registry.ts` holds `ProviderRegistry`, a `Map<ProviderId, ProviderAdapter<any, any>>`
built once at startup; `JobContext.providers` (ARCHITECTURE §7.1) is this registry plus the read-through
cache described in §2.6 below. Nothing outside `ingest/jobs/*` and the read-through may call
`adapter.fetch` — function resolvers reach data only through `DataServices` (FUNCTIONS §1.4).

### 1.2 The fetch / normalise split

The split is what makes FEED-08 achievable. `fetch` is the only impure half: it touches the network (or
the replay store), consumes rate-limit tokens, and may fail. `normalise` is a pure function of
`(bytes, context)` — it is the thing the fuzzers hit (QA-05), the thing the golden files in
`fixtures/providers/normalised/<file>.json` pin (ARCHITECTURE §8.1), and the thing that must produce
identical output on a 2026 laptop and a 2030 CI box. Concretely, a normaliser may not:

- call `Date.now()`, `Math.random()`, `new Date()` without an argument, or `Intl` with a default locale;
- read `process.env`, the database, or the plant;
- iterate a `Map`/`Set` built from provider keys in a way whose order leaks into output (sort explicitly);
- throw on an unexpected field. Unknown fields are ignored; missing required fields produce a
  `NormaliseProblem` and the affected row/update is dropped, never defaulted to `0`.

The one clock reading a normaliser gets is `ctx.capturedAt`, carried on the `RawRecord` and therefore
recorded in the manifest, so a replayed run computes the same `ts.cap` as the recorded one.

### 1.3 The ingest sequence

Every job runs the same six steps (ARCHITECTURE §6.2, expanded with the write-through):

```
1. hotset/scheduler picks the subjects              ingest/hotset.ts, ingest/scheduler.ts
2. raw   = await adapter.fetch(http, req)           providers/http.ts  (buckets, cache, breaker, mode)
3.         replayStore.record(raw)                  only when PROVIDER_MODE=record          (FEED-08)
4. provId = await insertProvenance(tx, raw, {adapterVersion, traceId, runId, sourceTs})     (DATA-10)
5. norm  = adapter.normalise(raw, { provenanceId: provId, capturedAt: raw.capturedAt, lines })
6.         for (const u of norm.updates) plant.apply(u);
           await writeRows(tx, norm.rows)           time series: upsert on natural key
                                                    reference: writeVersion/upsertVersion (§1.5)
```

`insertProvenance` (`providers/provenance.ts`) writes exactly one `provenance` row per non-304 exchange:

```ts
// packages/server/src/providers/provenance.ts
export async function insertProvenance(tx: Tx, raw: RawRecord, meta: {
  adapterVersion: string; sourceTs: Date | null; traceId?: string; runId?: number;
}): Promise<number>;
// → INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
//      http_status, bytes, captured_at, source_ts, adapter_version, trace_id, run_id) … RETURNING provenance_id
```

`provenance.source_id` is trigger-checked against `licence_registry` (`provenance_source_known` →
`assert_source_known`, DATA_MODEL L318), so an adapter whose licence row is missing cannot write a
single value. That is the enforcement mechanism behind DATA-09: registration is not a convention, it is
a foreign-key-by-trigger.

A `304 Not Modified` writes **no** provenance row and emits no update. The plant's `ts.cap` deliberately
does not advance: out of session `valueState` returns `'closed'` and nothing is claimed; in session a
genuinely frozen source therefore goes `'stale'` after `3 × expectedIntervalMs`, which is the signal
TERM-12 asks for. The scheduler counts the exchange in `ingest_runs.skipped`.

### 1.4 Adapter versioning

`adapter_version` is `'<family>/<semver>'` — `'cboe/1.0.0'`, `'yahoo/1.0.0'`, `'frankfurter/1.0.0'`,
`'coingecko/1.0.0'`. One version per adapter family (all four Cboe adapters share `cboe/*` because they
share `providers/cboe/parse.ts`). The rule set:

| Change | Bump | Consequence |
| --- | --- | --- |
| Bug fix that changes no output on any committed fixture | patch | golden files unchanged; CI proves it |
| Parse output changes (new field emitted, mapping corrected, unit fixed) | minor | `fixtures/providers/normalised/*.json` regenerated; the diff is reviewed in the PR |
| Endpoint/shape change that invalidates recorded captures | major | new captures recorded; every `fixtures/sessions/*` re-baselined (QA-02) |

Because `adapter_version` sits on `provenance`, a value stored in 2026 keeps pointing at the parser that
produced it. `GET /api/v1/admin/trace/:id` (`observability/traceQuery.ts`) and the `Ctrl+I` provenance
panel both surface it, so "the number changed because the parser changed" is answerable from the row.

### 1.5 Writing through `db/bitemporal.ts`

Adapters never `INSERT` into a bitemporal table directly. Reference rows go through the two exported
helpers (ARCHITECTURE §4.3):

```ts
// packages/server/src/db/bitemporal.ts
export interface VersionWrite<Row> {
  entityKey: Partial<Row>;                 // e.g. { instrumentId: 1042 } — the exclusion-constraint key
  validFrom: Date; validTo?: Date;         // default 'infinity'
  data: Omit<Row, BitemporalKeys | 'versionId'>;
  provenanceId: number;
  reason: 'initial' | 'change' | 'correction';
}
export function writeVersion<Row>(tx: Tx, table: BitemporalTable<Row>, w: VersionWrite<Row>): Promise<number>;
export function upsertVersion<Row>(tx: Tx, table: BitemporalTable<Row>, w: VersionWrite<Row>): Promise<number | null>;
```

- `writeVersion` always opens a new valid-time version (closing the previous one's `valid_to`) and
  returns the new `version_id`. Used when the provider is announcing a change (a ticker change, a new
  on-the-run bill).
- `upsertVersion` compares `data` against the current version field-by-field and returns `null` when
  nothing changed — no row, no `version_id`, no churn. This is what every poll-shaped adapter uses, and
  it is why re-running `cboeOptions.ts` a hundred times a day produces one `option_terms` row per
  contract, not a hundred.

Worked example — a new option contract seen in a Cboe chain:

```ts
const versionId = await upsertVersion(tx, optionTerms, {
  entityKey: { instrumentId },
  validFrom: new Date(raw.capturedAt),
  provenanceId,
  reason: 'initial',
  data: {
    occSymbol: 'AAPL260916C00245000',   // option_terms.occ_symbol, exactly as Cboe publishes it
    root: 'AAPL', underlyingInstrumentId, expiry: '2026-09-16', strike: '245.0000',
    putCall: 'C', exerciseStyle: 'american', settlement: 'physical', amPmSettlement: 'pm',
    multiplier: 100, tickSize: '0.0100', isWeekly: true, lastTradeDate: '2026-09-16',
  },
});
```

Time-series tables (`quote_ticks`, `bars_intraday`, `bars_daily`, `option_quotes`, `fx_rates`,
`econ_observations`, `curve_points`) are not bitemporal; they are idempotent upserts on their declared
primary keys, which is why every job in ARCHITECTURE §7.1 can be re-run safely. `bars_intraday` upserts
on `(instrument_id, bar_interval, bar_ts)` and may flip `is_final` from `false` to `true`;
`bars_daily` upserts on `(instrument_id, session_date)`.

---

## 2. `providers/http.ts` — the shared client

One `HttpClient` instance per process, injected into every adapter. It owns the mode switch, the token
buckets, the conditional-request cache, retries and the circuit breakers.

```ts
// packages/server/src/providers/http.ts
export type ProviderMode = 'live' | 'replay' | 'record';   // config.ts: PROVIDER_MODE, default 'replay'

export interface HttpRequest {
  providerId: ProviderId;
  method?: 'GET' | 'POST';              // default 'GET'
  url: string;
  headers?: Record<string, string>;     // merged over the per-provider defaults
  body?: string;                        // POST only (OpenFIGI); participates in the request key
  cacheTtlMs?: number;                  // 0 = always revalidate; >0 = serve from store without a request
  timeoutMs?: number;                   // default per provider, see the table below
  traceId?: string;                     // OPS-07 — copied onto provenance.trace_id
  runId?: number;                       // ingest_runs.run_id when the scheduler is the caller
  budgetShare?: 'scheduler' | 'interactive';   // scheduler may consume at most 70 % of a bucket
}

export interface HttpClient {
  get(req: HttpRequest): Promise<RawRecord>;
  post(req: HttpRequest & { body: string }): Promise<RawRecord>;
  breaker(id: ProviderId): { state: 'closed' | 'open' | 'half_open'; consecutiveFailures: number; openedAt: number | null };
  tokens(id: ProviderId): { capacity: number; available: number; refillPerSec: number };
}

export class ProviderHttpError extends Error {
  constructor(readonly providerId: ProviderId, readonly status: number, readonly url: string,
              readonly requestKey: string, readonly bodyPreview: string) { super(...); }
}
export class ProviderTimeoutError extends Error { /* providerId, url, timeoutMs */ }
export class CircuitOpenError    extends Error { /* providerId, openedAt, retryAtMs */ }
export class ReplayMissError     extends Error { /* providerId, method, url, requestKey, nearest */ }
```

### 2.1 Modes

| `PROVIDER_MODE` | Behaviour | Used by |
| --- | --- | --- |
| `replay` | Serve only from `fixtures/providers/manifest.json`. No transport is constructed at all — the undici dispatcher is a stub that throws. A miss throws `ReplayMissError`. | `npm test`, Playwright e2e, the offline demo. **Default.** |
| `record` | Live fetch, then write-through to the replay store (§3.4). | `npm run fixtures:record` |
| `live` | Network only; the replay store is not consulted or written. | `npm run dev`, `npm run test:live` |

`replay` is the default in `config.ts` precisely so that forgetting to set the variable cannot put a test
on the network (QA-02).

### 2.2 Per-provider defaults, buckets and the real limits

A token bucket per `ProviderId` (not per host — `query1` and `query2` share Yahoo's budget, and all four
Cboe adapters share Cboe's). Buckets are shared between the scheduler and interactive read-through calls;
a `budgetShare: 'scheduler'` request is refused when fewer than 30 % of the capacity remains, so an
analyst hitting `GO` is never starved by a backfill (ARCHITECTURE §7.1).

| Provider | Bucket | Capacity / refill | Timeout | Mandatory headers | Notes |
| --- | --- | --- | --- | --- | --- |
| `openfigi.mapping` | 25 / min | 25, refill 0.4167/s | 10 s | `Content-Type: application/json`; `X-OPENFIGI-APIKEY` when `OPENFIGI_API_KEY` is set | Keyless limit is 25 requests/min **and 10 jobs per request**. The adapter chunks its job array into groups of 10 and issues ⌈n/10⌉ requests; 250 mappings/minute is the keyless ceiling. With a key the bucket is raised to 25/6 s and 100 jobs/request by config, not by code change. |
| `sec.*` | 10 / s | 10, refill 10/s | 20 s | `User-Agent: ${SEC_USER_AGENT}`, `Accept-Encoding: gzip, deflate` | `SEC_USER_AGENT` is validated by the `config.ts` zod schema against `/^.+\s+\S+@\S+\.\S+$/` — a descriptive string carrying a contact email. The process refuses to start in `live`/`record` mode without it. SEC returns `403` with an HTML body to a default UA. |
| `cboe.*` | 4 / s | 8, refill 4/s | 10 s | `Accept: application/json`, `Accept-Encoding: gzip` | The CDN publishes no documented rate limit and is cache-friendly; 4/s is our self-imposed politeness ceiling. `If-None-Match` is always sent (§2.4) — the CDN answers `304` with an empty body, which is the whole point of the budget. |
| `yahoo.*` | 2 / s | 4, refill 2/s | 15 s | `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36`, `Accept: application/json` | **Without a browser-like UA the endpoint returns HTTP 200 with a zero-length body**, not an error. The client treats `status === 200 && body.length === 0` from `yahoo.*` as a hard failure (`ProviderHttpError` with status 200) so it trips the breaker instead of being parsed into "no bars". |
| `frankfurter` | 1 / s | 2, refill 1/s | 10 s | `Accept: application/json` | |
| `coingecko.simple` | 1 / s | 2, refill 1/s | 10 s | `Accept: application/json` | Keyless demo tier; `429` is common and is retried with the backoff below. |
| `fred.csv`, `fred.calendar` | 1 / s | 2, refill 1/s | 20 s | — | |
| `bls.*` | 25 / day | 25, refill 25/day | 20 s | `Content-Type: application/json` | Daily bucket persisted in `schema_meta` so a restart does not reset it. |
| `treasury.*` | 1 / min | 1, refill 1/60 s | 45 s | — | The yield-curve XML takes ≈ 18 s; scheduler-only. |
| everything else | 1 / s | 2, refill 1/s | 20 s | — | |

### 2.3 Retry and backoff

Retries only on `408`, `425`, `429`, `5xx`, and transport errors (DNS, ECONNRESET, timeout). `4xx` other
than those is terminal — a `404` on `quotes/XYZ.json` means the symbol is not published, which is a
`NormaliseProblem`/`data_exceptions` matter, not a network matter.

```
attempt n ∈ {1,2,3}:  delayMs = min(30_000, 500 * 2 ** (n - 1)) * (0.5 + rng())
```

`rng` is injected (`crypto`-seeded in `live`/`record`). In `replay` mode there are no retries at all:
either the capture is in the store or the run fails. `Retry-After` on a `429` overrides the computed
delay when it is smaller than 30 s.

### 2.4 Conditional requests and the TTL cache

The store keeps, per `requestKey`, the last `etag`, `last-modified`, `status`, body and the instant it
was validated.

- `cacheTtlMs > 0` and the entry is younger than the TTL → return it immediately, `origin: 'cache'`,
  no token consumed, no request.
- otherwise send `If-None-Match: <etag>` and/or `If-Modified-Since: <last-modified>` when known.
- `304` → `RawRecord { status: 304, body: <stored body>, origin: 'cache' }`; per §1.3 no provenance row,
  no update, `ingest_runs.skipped += 1`.
- `200` → new body; if `sha256` is unchanged the record still flows (the adapter's own dedupe — Cboe's
  `seqno`, Yahoo's `regularMarketTime` — decides whether anything is applied).

TTLs in use: `cboe.quotes` 0, `cboe.options` 0, `cboe.symbolBook` 6 h, `cboe.euIndices` 0,
`yahoo.chart` 0 for `1m`/`5m` ranges and 6 h for `range=max`, `yahoo.search` 5 min, `frankfurter` 1 h,
`coingecko.simple` 30 s.

### 2.5 Circuit breaker → `PROVIDER_DOWN`

Per `ProviderId`: 5 consecutive failures open the breaker; it half-opens 60 s later and lets exactly one
probe through; success closes it, failure re-opens with the same 60 s (ARCHITECTURE §7.1). While open:

1. `http.get` throws `CircuitOpenError` without consuming a token.
2. A `dq_events` row is written once per opening: `kind = 'provider_circuit_open'`, `severity = 'error'`,
   `source_id`, `details = { consecutiveFailures, lastStatus, lastUrl, openedAt }` (OPS-03).
3. Every `md_lines` row with that `source_id` is marked, so each affected `QuoteState.dq` gains
   `'PROVIDER_DOWN'`; `core/quote/staleness.ts#valueState` then returns `'stale'` regardless of age, and
   the plant's 1 s sweep (`plant/staleness.ts`) emits a `status` frame with
   `st: 'stale', reason: 'PROVIDER_DOWN'` (TERM-12, BUS-08).
4. A `status_incidents` row opens with `component = 'provider:<sourceId>'`, `severity = 'degraded'`
   (`'outage'` when the provider is the only line for its asset class), and `sys:status` carries it to
   every connected terminal (OPS-04).

`ReplayMissError` explicitly does **not** count as a failure — a missing fixture is a test defect, and
tripping the breaker would mask it behind a stale screen.

### 2.6 Read-through for interactive requests

`ctx.providers.get(kind, key, { maxAgeMs })` (FUNCTIONS §1.4 `ReadThrough`) is the only path by which a
function resolver can cause a fetch. It checks the database/plant first, and only if the stored value is
older than `maxAgeMs` does it call the same adapter through the same buckets, marked
`budgetShare: 'interactive'`. Sources whose fetch is slow (Treasury XML ≈ 18 s) are declared
scheduler-only in the registry and their read-through never fetches — it returns what `curve_points` has,
with its real `captured_at`, and the screen shows the age.

---

## 3. The replay store (FEED-08, QA-02)

### 3.1 On-disk layout

```
fixtures/providers/
  manifest.json                     requestKey → capture metadata (§3.3)
  raw/                              the 50 files recorded on 2026-09-15, original names preserved
    cboe-quote-AAPL.json  cboe-spx  cboe-vix  cboe-options  cboe-symbol-book.json  cboe-eu-indices
    yahoo-chart-1m  yahoo-chart-AAPL-1d-1m.json  yahoo-chart-AAPL-max-1d.json
    yahoo-chart-SPX-5d-5m.json  yahoo-chart-events  yahoo-ftse  yahoo-fx  yahoo-bond  yahoo-search
    frankfurter  coingecko-simple.json  openfigi-map  openfigi-search  sec-*  fred-*  nyfed-*  …
  raw/<providerId>/<requestKey>.<ext>     everything recorded after the import (record mode)
  normalised/<file>.json            golden normaliser output, one per raw file (ARCHITECTURE §8.1)
fixtures/sessions/<name>/           plant session replay: events.ndjson, subscriptions.json, expected.ndjson
```

`REPLAY_DIR` (`config.ts`, default `../../fixtures/providers`) points at the first directory.

### 3.2 `requestKey` derivation

```ts
// packages/server/src/providers/replayStore.ts
export function canonicalUrl(url: string): string;
export function requestKey(providerId: ProviderId, method: 'GET' | 'POST', url: string, body?: string): string;
```

```
requestKey = sha256( providerId + '|' + METHOD + '|' + canonicalUrl(url) + '|' + sha256(body ?? '') ).hex
```

`canonicalUrl` is normative because the key is only stable if every caller spells the URL the same way:

1. lower-case scheme and host; drop a default port; drop the fragment;
2. keep the path byte-for-byte after `encodeURIComponent` on each segment — `^GSPC` is `%5EGSPC`,
   `EURUSD=X` is `EURUSD%3DX`, `_SPX` is `_SPX`;
3. sort query parameters by name, then by value, both as UTF-8 byte comparisons; re-encode values with
   `encodeURIComponent` — so `events=div|split` is always `events=div%7Csplit`;
4. drop a parameter with an empty name; keep a parameter with an empty value as `name=`;
5. emit `?` only when at least one parameter survives.

`METHOD` is upper-case. `body` is the exact request body string (OpenFIGI's JSON job array), not a
re-serialised object — two different orderings of the same JSON are two different keys, deliberately.
The same hex string is stored on `provenance.request_key`, so the `Ctrl+I` panel can jump from any cell
on screen to the raw bytes that produced it (DATA-10).

### 3.3 `manifest.json` schema

```jsonc
{
  "e3f1…9ab": {                                   // the requestKey, lower-case hex
    "providerId": "cboe.quotes",
    "method": "GET",
    "url": "https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json",
    "captures": [
      {
        "file": "raw/cboe-quote-AAPL.json",       // path relative to REPLAY_DIR
        "status": 200,
        "bytes": 512,
        "sha256": "9c1d…",                        // of the file bytes; verified on every load
        "capturedAt": "2026-09-15T18:41:28Z",     // → RawRecord.capturedAt (FEED-05 'cap')
        "sourceTs": "2026-09-15T18:41:28Z",       // provider-published instant, null when none
        "headers": { "content-type": "application/json", "etag": "\"6c9f-…\"" },
        "note": "imported by scripts/fixtures-import.ts"
      }
    ]
  }
}
```

**Addition required.** ARCHITECTURE §8.1 fixes a single-capture value object
(`{file, providerId, url, capturedAt, sha256, sourceTs}`). Two of the recorded files —
`yahoo-chart-1m` and `yahoo-chart-AAPL-1d-1m.json` — are the *same* request
(`chart/AAPL?range=1d&interval=1m`) captured four minutes apart, and therefore collide on one
`requestKey`. The single-capture shape would silently drop one. This document therefore specifies
`captures[]` plus the extra `method`, `status`, `bytes` and `headers` fields (the last needed for the
ETag path in §2.4). Replay serves `captures[0]` unless the caller asks for an index; a session's
`events.ndjson` line may carry `captureIndex` so a session can walk a symbol through successive
captures. `yahoo-chart-events` (`range=5y`) and `yahoo-chart-AAPL-max-1d.json` (`range=max`) are
distinct URLs and do not collide.

Store API:

```ts
export interface ReplayStore {
  lookup(key: string, captureIndex?: number): RawRecord | null;
  record(raw: RawRecord): void;                 // record mode; appends a capture, never overwrites
  has(key: string): boolean;
  nearest(providerId: ProviderId, url: string): { url: string; key: string } | null;  // miss diagnostics
}
```

### 3.4 Importing the 50 recorded files — `scripts/fixtures-import.ts`

The recorded files were captured by hand and named for humans: `yahoo-fx`, `cboe-spx`, `frankfurter`.
Their names encode neither the host nor the query string, and several have no extension. The importer
therefore reconstructs each request from a hand-maintained map and computes the key from that:

```ts
// scripts/fixtures-urls.ts  —  ADDITION REQUIRED (not named in ARCHITECTURE §8.1)
export interface FixtureUrl { providerId: ProviderId; method: 'GET' | 'POST'; url: string; body?: string;
                              sourceTsPath?: string; capturedAtPath?: string }
export const FIXTURE_URLS: Record<string, FixtureUrl> = {
  'cboe-quote-AAPL.json':  { providerId: 'cboe.quotes',    method: 'GET', url: 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json',            sourceTsPath: '/timestamp' },
  'cboe-spx':              { providerId: 'cboe.quotes',    method: 'GET', url: 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_SPX.json',            sourceTsPath: '/timestamp' },
  'cboe-vix':              { providerId: 'cboe.quotes',    method: 'GET', url: 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json',            sourceTsPath: '/timestamp' },
  'cboe-options':          { providerId: 'cboe.options',   method: 'GET', url: 'https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json',           sourceTsPath: '/timestamp' },
  'cboe-symbol-book.json': { providerId: 'cboe.symbolBook',method: 'GET', url: 'https://cdn.cboe.com/api/global/delayed_quotes/symbol_book/symbol-book.json',sourceTsPath: '/timestamp' },
  'cboe-eu-indices':       { providerId: 'cboe.euIndices', method: 'GET', url: 'https://cdn.cboe.com/api/global/european_indices/index_quotes/BUK100P.json' },
  'yahoo-chart-1m':               { providerId: 'yahoo.chart', method: 'GET', url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1m',                    capturedAtPath: '/chart/result/0/meta/regularMarketTime' },
  'yahoo-chart-AAPL-1d-1m.json':  { providerId: 'yahoo.chart', method: 'GET', url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1m',                    capturedAtPath: '/chart/result/0/meta/regularMarketTime' },
  'yahoo-chart-AAPL-max-1d.json': { providerId: 'yahoo.chart', method: 'GET', url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=max&interval=1d&events=div%7Csplit' },
  'yahoo-chart-events':           { providerId: 'yahoo.chart', method: 'GET', url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5y&interval=1d&events=div%7Csplit' },
  'yahoo-chart-SPX-5d-5m.json':   { providerId: 'yahoo.chart', method: 'GET', url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=5m' },
  'yahoo-ftse':                   { providerId: 'yahoo.chart', method: 'GET', url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?range=1d&interval=5m' },
  'yahoo-fx':                     { providerId: 'yahoo.chart', method: 'GET', url: 'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD%3DX?range=1d&interval=5m' },
  'yahoo-bond':                   { providerId: 'yahoo.chart', method: 'GET', url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=1d&interval=5m' },
  'yahoo-search':                 { providerId: 'yahoo.search',method: 'GET', url: 'https://query2.finance.yahoo.com/v1/finance/search?newsCount=0&q=apple&quotesCount=8' },
  'frankfurter':                  { providerId: 'frankfurter', method: 'GET', url: 'https://api.frankfurter.dev/v1/latest?base=USD',                          sourceTsPath: '/date' },
  'coingecko-simple.json':        { providerId: 'coingecko.simple', method: 'GET', url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Cethereum&include_24hr_change=true&vs_currencies=usd' },
  // … one entry per remaining raw file (openfigi-*, sec-*, fred-*, nyfed-*, bls-*, treasury-*,
  //     bbg-rss-*, fed-*, finra-trace, worldbank, imf-weo, ssga-spy-holdings.xlsx, wiki-sp500.html)
};
```

`scripts/fixtures-import.ts` then, for every file in `raw/` (non-recursive, so previously recorded
`raw/<providerId>/…` files are left alone):

1. looks the basename up in `FIXTURE_URLS`; **an unmapped file is a hard error**, so adding a fixture
   without a URL cannot go unnoticed;
2. computes `sha256` and `bytes` of the bytes on disk;
3. derives `capturedAt`: from `capturedAtPath` (Yahoo `meta.regularMarketTime`, epoch seconds × 1000)
   when given, else from `sourceTsPath` (Cboe `timestamp`, frankfurter `date`), else the file's mtime;
4. derives `sourceTs` from `sourceTsPath` using the per-provider timestamp rules in §5;
5. computes `requestKey(providerId, method, url, body)` and merges a `captures[]` entry into
   `manifest.json`, keyed and ordered deterministically (keys sorted, captures sorted by `capturedAt`);
6. re-writes `manifest.json` with two-space indent and a trailing newline so the diff is reviewable.

The importer is idempotent: running it twice produces a byte-identical manifest. `npm run fixtures:import`.

### 3.5 Record mode

`PROVIDER_MODE=record npm run fixtures:record -- --job cboe.quotes.poll` runs the real jobs against the
network and write-throughs every `RawRecord`:

- file path `raw/<providerId>/<requestKey>.<ext>`, `ext` from `content-type`
  (`application/json`→`json`, `text/csv`→`csv`, `*/xml`→`xml`, `text/html`→`html`,
  `…spreadsheetml…`→`xlsx`, otherwise `bin`);
- a capture whose `sha256` already exists under that key is skipped; a different `sha256` is **appended**
  to `captures[]`, never overwritten, so a recording session can capture a symbol ticking;
- `304` responses are not recorded (there is nothing new to store);
- responses over 8 MB are refused with a message naming the URL, so a stray full-history pull cannot
  bloat the repository.

### 3.6 Replay mode is a wall, not a preference

In `replay` mode the client is constructed with a transport stub whose `request()` throws
`new Error('network access is disabled under PROVIDER_MODE=replay')`. A miss produces:

```
ReplayMissError: no capture for cboe.quotes GET https://cdn.cboe.com/api/global/delayed_quotes/quotes/MSFT.json
  requestKey 4b2a…f01
  nearest    https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json (e3f1…9ab)
  fix        add the URL to scripts/fixtures-urls.ts and re-run `npm run fixtures:import`,
             or capture it with `npm run fixtures:record`
```

`nearest` is the manifest entry for the same `providerId` with the smallest edit distance to the
canonical URL, which turns "a query parameter drifted" from a twenty-minute hunt into a one-line diff.
The error is never caught by the scheduler's failure handler (§2.5) and never converted into a
`dq_events` row: it fails the test. `packages/server/test/replay/no-network.test.ts` (**addition
required**, the server analogue of `packages/web/test/no-direct-io.test.ts`) asserts that with
`PROVIDER_MODE=replay` no `undici`/`http`/`https` request is ever constructed during the whole suite.

---

## 4. The deterministic simulated feed

Replay proves that yesterday's bytes still produce yesterday's numbers. It cannot produce a market that
ticks for an hour. Development and the WebSocket tests need a feed that moves continuously, is cheap, and
is bit-identical run to run — otherwise conflation, backpressure and flash-rendering tests are flaky by
construction.

**Addition required.** No file in CONTRACTS.md covers this. The simulated feed lives at
`packages/server/src/providers/sim/` (`prng.ts`, `feed.ts`, `paths.ts`), it is enabled by a new
`config.ts` env `SIM_FEED=0|1` (default `0`), and it refuses to start when `NODE_ENV=production`.

### 4.1 Seeded PRNG — `providers/sim/prng.ts`

```ts
/** xoshiro128** — 128-bit state, ~2^128 period, no allocation per draw. */
export function xoshiro128ss(seed: number): () => number;          // → [0,1)
export function hash32(s: string): number;                         // FNV-1a 32, for per-subject seeding
export function gaussian(rng: () => number): number;               // Box–Muller, cached second draw
```

One stream per subject, seeded `xoshiro128ss(hash32(`${seed}|${subject}`))`, never a shared global. That
is what makes the feed composable: adding `q:77` to a scenario does not shift the path of `q:42`, so a
test that pins AAPL's tick sequence keeps passing when someone adds MSFT to the fixture.

### 4.2 VirtualClock — `packages/server/src/test/clock.ts`

```ts
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): Handle; clearTimeout(h: Handle): void }
export class VirtualClock implements Clock {
  constructor(startMs: number);
  now(): number;
  advance(ms: number): void;        // fires every due timer in (time, time+ms], in (dueAt, seq) order
  runUntil(untilMs: number): void;
  readonly firedCount: number;
}
```

Ties are broken by insertion sequence, so two timers due at the same virtual millisecond always fire in
the same order. The scheduler, the plant staleness sweep, the conflator flush loop and the sim feed all
take the injected `Clock`; none of them calls `Date.now()` or the platform `setTimeout`.

### 4.3 Driving `plant.apply`

```ts
export interface SimFeedConfig {
  seed: number;                      // the whole run's identity
  startMs: number;                   // virtual wall time at t0
  rateHz: number;                    // updates per second per subject (default 1; WS tests use 50)
  subjects: Array<{
    subject: string; instrumentId: number; mdLineId: number; assetClass: AssetClass; tier: Tier;
    px0: number; annualVolPct: number; spreadBp: number; avgTradeSize: number; calendarId: string;
  }>;
}
export class SimFeed {
  constructor(cfg: SimFeedConfig, deps: { clock: Clock; plant: TickerPlant; provenanceId: number });
  start(): void; stop(): void;
  readonly ticks: number;
}
```

Each tick, for each subject, in the subjects' declared order:

1. `dt = 1 / (rateHz * 6.5 * 3600 * 252)` years; `px *= exp((-σ²/2)·dt + σ·√dt·gaussian(rng))`;
2. bid/ask straddle the mid at `spreadBp/2`, rounded to the instrument's tick;
3. an integer size is drawn from `avgTradeSize · (0.25 + 1.5·rng())`;
4. `session` comes from `refdata/calendars.ts` evaluated at `clock.now()` — so a sim run crossing 16:00 ET
   really does transition `open → closed` and exercises the `closed` branch of `valueState`;
5. it emits a `NormalisedUpdate` — the identical type every real normaliser emits, so the plant, the
   compositor, the conflator and the wire encoder are all exercised unmodified:

```ts
plant.apply({
  subject, instrumentId, mdLineId, assetClass, tier: 'delayed',
  fields: { PX_LAST: px, PX_BID: bid, PX_ASK: ask, BID_SIZE: bs, ASK_SIZE: as,
            LAST_SIZE: sz, LAST_TRADE_TIME: srcTs, PX_VOLUME: cumVol },
  ts: { src: srcTs, cap: clock.now(), pub: 0 },     // pub is set by the plant
  prov: { sourceId: 'internal.derived', provenanceId, srcSeq: ++seq },
  session,
});
```

`provenanceId` is a single real `provenance` row inserted at start-up with
`source_id = 'internal.derived'`, `request_key = 'sim:<seed>:<startMs>'`,
`adapter_version = 'sim/1.0.0'`, `http_status = 0`, `bytes = 0` — `internal.derived` is already a
registered `licence_registry` source (it backs `calendars.source_id` and `curves.source_id`), so the
`provenance_source_known` trigger is satisfied and every simulated number is visibly simulated in the
`Ctrl+I` panel. Persisted simulated ticks carry `quote_ticks.conditions = {'synthetic_from_poll'}`.

### 4.4 Why runs are bit-identical

- every random draw comes from the per-subject `xoshiro128ss` stream, in a fixed order;
- every time value comes from `VirtualClock`, never the platform clock;
- price arithmetic is IEEE-754 double in a fixed operation order, so it is reproducible across machines;
- the plant's `seq` is a pure counter and `changed`-field computation is NaN-safe and order-independent;
- the output is written through the same state log as the replay harness (`(subject, seq, changedFields,
  ts.src)` plus outbound WS frames per reference subscriber), and `replay:diff` compares two logs
  ignoring `ts.cap`/`ts.pub` (ARCHITECTURE §8.2).

So `SIM_FEED=1 npm run replay:run -- --session sim-ws-backpressure --speed max` twice yields two
identical `expected.ndjson` files, and a conflation or slow-consumer regression shows up as a diff at a
named frame rather than as an intermittent failure. `npm run dev` with `SIM_FEED=1` gives a terminal
whose grid flashes without any network at all.

---

## 5. Market-data adapters

Cross-cutting rules that hold for all of them:

- **Three timestamp conventions, fixed once** (ARCHITECTURE §4.2): Cboe `last_trade_time`
  (`"2026-09-15T14:26:26"`) is naive `America/New_York` and becomes `ts.src`; Cboe top-level `timestamp`
  (`"2026-09-15 18:41:28"`) is UTC and becomes `provenance.source_ts`; Yahoo `meta.regularMarketTime`
  and `timestamp[]` are epoch **seconds** UTC (× 1000). `LAST_TRADE_TIME` is always epoch ms.
- **Derived fields are never taken from a provider.** `CHG_NET_1D`, `CHG_PCT_1D` and `TICK_DIR` are
  computed by `core/quote/derive.ts`, so Cboe's `price_change`, `price_change_percent` and `tick` are
  parsed, compared, and used only as a QA-03 cross-check — a mismatch beyond 1 tick raises a
  `dq_events` row of kind `'reconcile_mismatch'`, it does not change the published number.
- **Zeros are not values.** A `0` bid on `_SPX`, a `0` volume on `^VIX`, a `0` open on a European index
  before the open: these are "not applicable / not yet", and writing them would render a number where a
  `—` belongs. Every adapter drops them explicitly (rules per adapter below).
- **Staleness tier** is the pair (`md_lines.intrinsic_delay_min`, `md_lines.expected_interval_ms`) plus
  the source's `licence_registry.max_tier`. `valueState` calls a value stale after
  `3 × expected_interval_ms` without a capture, so `expected_interval_ms` must match the job's real
  cadence including its off-hours cadence, not its aspiration.

### 5.1 `cboe.quotes` — delayed top-of-book and session summary

**Endpoint** `GET https://cdn.cboe.com/api/global/delayed_quotes/quotes/{SYMBOL}.json`.
`{SYMBOL}` is the equity ticker for stocks and ETFs (`AAPL`, `SPY`) and the underscore form for indices
(`_SPX`, `_VIX`) — the leading `_` is the Cboe convention, and `md_lines.provider_symbol` stores exactly
what goes in the URL.
**Headers** `Accept: application/json`, `Accept-Encoding: gzip`, `If-None-Match` when known. No key, no UA
requirement. **Fixtures** `cboe-quote-AAPL.json`, `cboe-spx`, `cboe-vix` (FIXTURES.md §cboe-quote-AAPL,
§cboe-spx, §cboe-vix).

**Parse rules** (`providers/cboe/parse.ts#normaliseQuote`), against `{ timestamp, data: {…}, symbol }`:

| Payload field | Becomes | Rule |
| --- | --- | --- |
| `timestamp` `"2026-09-15 18:41:28"` | `provenance.source_ts` | parsed as UTC; the `T`-less space form is Cboe's |
| `data.last_trade_time` `"2026-09-15T14:26:26"` | `ts.src`, `LAST_TRADE_TIME`, `quote_ticks.source_ts` | naive → `America/New_York` → UTC epoch ms |
| `data.current_price` | `PX_LAST`, `quote_ticks.price` | |
| `data.bid` / `data.ask` | `PX_BID` / `PX_ASK` | dropped when `security_type = 'index'` **or** the value is `0` with the matching size `0` (`_SPX` publishes `bid 7584.49 / bid_size 1`, `_VIX` publishes `0/0` — the first is kept, the second dropped) |
| `data.bid_size` / `data.ask_size` | `BID_SIZE` / `ASK_SIZE` | dropped with their price |
| `data.open` / `high` / `low` | `PX_OPEN` / `PX_HIGH` / `PX_LOW` | `open = 0` is dropped (pre-open) |
| `data.close` | `PX_OFFICIAL_CLOSE`, `bars_daily.official_close` | **only after the session closes.** Intra-session Cboe sets `close = current_price` (the AAPL fixture shows `close 330.27 = current_price 330.27`); writing it would publish a fake official close. Gated on `session ∈ {closed, post}` from `refdata/calendars.ts`. |
| `data.prev_day_close` | `PX_CLOSE_1D` | the input to derived `CHG_NET_1D`/`CHG_PCT_1D` |
| `data.volume` | `PX_VOLUME` | dropped when `security_type = 'index'` (indices publish `0`) |
| `data.iv30` | `IVOL_30D` | Cboe is the only source of this field (BUS-05) |
| `data.seqno` | `prov.srcSeq`, `quote_ticks.src_seq` | monotonic per symbol; `plant.apply` step 2 drops `seqno ≤ last` without inventing anything |
| `data.exchange_id` | cross-check against `exchanges.cboe_exchange_id` | `2` = Nasdaq-listed stock, `5` = Cboe index |
| `data.security_type` | selects the index/stock branch | `'stock'` \| `'index'` |
| `data.tick`, `price_change`, `price_change_percent` | QA-03 cross-check only | never published |

**Writes**: plant `q:<instrumentId>` (and `l:<mdLineId>` for QM); `quote_ticks(capture_ts, tick_id,
instrument_id, md_line_id, kind='summary', source_ts, publish_ts, src_seq, price, bid, ask, bid_size,
ask_size, open, high, low, prev_close, volume, iv30, tick_dir, conditions={'delayed'}, session_state,
provenance_id)`; `quote_snapshots(instrument_id, subject, seq, state, updated_at)` on every applied
change; `eod_snapshots(instrument_id, session_date, fields, close_ts, provenance_id)` at the close via
`plant/eod.ts`.

**Cadence and hot set** — `ingest/jobs/cboeQuotes.ts`: every 10 s (jitter ± 1 s) over the hot set
04:00–20:00 ET, every 5 min off-hours, concurrency 4, bucket 4 req/s. The hot set is
`(subjects with ≥ 1 WS subscriber) ∪ (watchlist members of connected users) ∪ (always-on seed: WEI
indices, VIX, benchmark Treasuries, G10 FX, SOFR/EFFR)`, ordered by `(subscriber count desc, last poll
asc)`, decaying out 300 s after the last subscriber leaves.

**Staleness tier** — `md_lines`: `source_id 'cboe.quotes'`, `provider_symbol` as in the URL,
`line_kind 'composite'` (`listing_id NULL`: Cboe's `current_price` is the consolidated last),
`intrinsic_delay_min 15`, `expected_interval_ms 10000`, `priority 10` (wins ties in the composite merge).

**Licence row** (`providers/licences.ts`):

| column | value |
| --- | --- |
| `source_id` / `source_name` | `cboe.quotes` / `Cboe Delayed Quotes` |
| `publisher` | `Cboe Global Markets` |
| `terms_url` | `https://www.cboe.com/us/equities/market_statistics/` |
| `contract_ref` | `NULL` (DATA-01 gap: no signed agreement) |
| `licence_kind` | `exchange_delayed` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `false` / `true` / `false` |
| `export_allowed` / `api_allowed` | `true` / `true` |
| `max_tier` / `intrinsic_delay_min` | `delayed` / `15` |
| `retention_days` | `400` (ticks; the only input to partition drops, STOR-07) |
| `attribution` | `Quotes delayed at least 15 minutes. Source: Cboe Global Markets.` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `4/s (self-imposed)` / `false` / `NULL` |
| `audit_obligation` | `Monthly display-user count per ENTL-06 declaration query` |

**Failures and data quality (OPS-03, QA-03)** — `404` → the symbol is not published by Cboe:
a `data_exceptions` row, `kind 'unresolved_identifier'`, and the md line is retired rather than retried.
Non-monotonic `seqno` (a CDN edge serving an older object) → drop, `plant_updates_dropped_total
{reason="stale_seq"}`. `last_trade_time` more than 30 min behind `timestamp` during an open session →
`dq_events kind 'stale_tick'`. `current_price` outside `[0.2 × prev_day_close, 5 × prev_day_close]` →
the update is dropped and `dq_events kind 'parse_error'` carries both values. Cboe close vs Yahoo close
per hot instrument, divergence > 0.5 % → `dq_events kind 'cross_source_divergence'`
(`ingest/jobs/reconcile.ts`, 18:45 ET). `field_population` monitors alert when `PX_BID` populates on
fewer than 95 % of open-session polls for a line that normally publishes a book.

### 5.2 `cboe.options` — full chain with greeks and IV

**Endpoint** `GET https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json`. **Headers** as
§5.1. **Fixture** `cboe-options` (FIXTURES.md §cboe-options) — 1.5 MB, 3,510 contracts for AAPL, plus a
full underlying quote block in the same payload.

**Parse rules** (`providers/cboe/parse.ts#normaliseChain`). The payload is
`{ timestamp, data: { options: [...], …underlying fields… }, symbol }`, so one fetch yields three things:

1. **The underlying quote.** `data.{symbol, security_type, exchange_id, current_price, bid, ask,
   bid_size, ask_size, open, high, low, close, prev_day_close, volume, iv30, seqno, last_trade_time,
   tick}` is byte-for-byte the §5.1 shape and goes through the same code path, on its own md line
   (`source_id 'cboe.options'`) so BUS-05 can compare it against the `cboe.quotes` line.
2. **Contract terms** for any `option` string not yet in `option_terms`. `core/ids/occ.ts` parses
   `"AAPL260916C00245000"` → root `AAPL`, expiry `2026-09-16`, `C`, strike `245.0000`
   (last 8 digits ÷ 1000). `option_terms.occ_symbol` stores the Cboe form with the root unpadded;
   the padded OSI form is derived, never stored twice. Written with `upsertVersion` (§1.5) —
   `multiplier 100`, `exercise_style 'american'`, `settlement 'physical'`, `am_pm_settlement 'pm'`,
   `tick_size 0.0100`, `is_weekly` from the expiry's weekday/month position, `last_trade_date = expiry`.
   Instruments are minted first: `instruments(asset_class 'option', market_sector 'Equity',
   ticker = occ_symbol, exch_code 'US', currency 'USD')` and an `identifiers` row
   `(entity_kind 'instrument', scheme 'OCC', value = occ_symbol, qualifier '')`.
3. **Contract quotes.** Per element of `data.options[]`:

| Payload field | Column / field |
| --- | --- |
| `option` | resolves `option_quotes.instrument_id` via `identifiers` scheme `OCC` |
| `bid`, `ask`, `bid_size`, `ask_size` | `option_quotes.bid/ask/bid_size/ask_size` |
| `last_trade_price`, `last_trade_time` | `last`, `last_ts` (naive ET → UTC) |
| `prev_day_close` | `prev_close` |
| `volume`, `open_interest` | `volume`, `open_interest` |
| `iv` | `iv` and plant `OPT_IV` — Cboe publishes it as a decimal (`2.3515` = 235 %), stored as published |
| `delta`, `gamma`, `vega`, `theta`, `rho`, `theo` | `delta, gamma, vega, theta, rho, theo` and `OPT_DELTA/GAMMA/VEGA/THETA/RHO/THEO` |
| `data.current_price` | `option_quotes.underlying_px`, `OPT_UNDL_PX` |
| `change`, `percent_change`, `tick`, `open`, `high`, `low` | cross-check only (derived fields rule) |

**Writes**: `option_terms` (bitemporal, `upsertVersion`); `instruments` + `identifiers` for new contracts;
`option_quotes(capture_ts, instrument_id, underlying_instrument_id, md_line_id, bid, ask, bid_size,
ask_size, last, last_ts, prev_close, volume, open_interest, iv, delta, gamma, vega, theta, rho, theo,
underlying_px, provenance_id)`; plant `q:<contractInstrumentId>` for subscribed contracts only; plant
`oc:<underlyingInstrumentId>` with `EXPIRIES, ATM_IV, PUT_CALL_RATIO, CONTRACT_COUNT` computed in the
normaliser (`ATM_IV` = the `iv` of the nearest-strike pair on the front expiry, averaged C/P;
`PUT_CALL_RATIO` = Σ put `volume` / Σ call `volume`, `null` when the call total is `0`).

**Cadence and hot set** — `ingest/jobs/cboeOptions.ts`: 60 s for underlyings with an `oc:` or option `q:`
subscriber, daily otherwise. The payload is 1.5 MB, so the job is never speculative: an underlying with
no option subscriber is polled once a day for terms, and `cacheTtlMs 0` with `If-None-Match` keeps the
60 s poll cheap when the chain has not moved. Only contracts that are subscribed, or within ±10 strikes
of the money on the front three expiries, produce plant updates; the rest are persisted and not fanned out.

**Staleness tier** — `md_lines`: `source_id 'cboe.options'`, `provider_symbol = underlying ticker`,
`line_kind 'composite'`, `intrinsic_delay_min 15`, `expected_interval_ms 60000`, `priority 10`.

**Licence row** — as §5.1 with `source_id 'cboe.options'`, `source_name 'Cboe Delayed Option Chains'`,
`retention_days 400`, `attribution 'Option quotes and greeks delayed at least 15 minutes. Source: Cboe
Global Markets.'`. `derived true` matters here: the greeks are Cboe's model output, and OVML/OMON
re-derive their own from `vol_surfaces` rather than restating Cboe's as ours.

**Failures and data quality** — a contract whose `bid > ask` (crossed) is persisted but suppressed from
the plant with `dq_events kind 'parse_error'`. `iv = 0` with a non-zero `bid` → `field_dropped` problem;
`OPT_IV` is left absent so the screen shows `—`. A chain whose `options` array shrinks by more than 20 %
between polls → `dq_events kind 'poll_anomaly'` (usually a truncated CDN object). Greeks are range-checked
(`|delta| ≤ 1`, `gamma ≥ 0`, `vega ≥ 0`) and out-of-range values are dropped per field, not per contract.

### 5.3 `cboe.symbolBook` — the 35,618-entry universe

**Endpoint** `GET https://cdn.cboe.com/api/global/delayed_quotes/symbol_book/symbol-book.json`.
**Fixture** `cboe-symbol-book.json` (FIXTURES.md §cboe-symbol-book.json) — 2.2 MB,
`{ timestamp: "2026-09-15 18:00:09", data: [35618 × {name, company_name}], symbol: "symbol-book" }`.

**Parse rules**: `data[].name` is the Cboe symbol, `data[].company_name` the description. The array is
sorted by `name` in the payload; the normaliser sorts again explicitly so the output does not depend on
the provider's ordering. Entries are classified by shape before anything is written:

- plain 1–5 letter alphabetic `name` → equity/ETF candidate;
- `name` matching `/^[A-Z0-9]{2,6}[FGHJKMNQUVXZ]\d$/` with a `company_name` containing `Futures` →
  futures candidate, excluded from the equity universe;
- `name` starting `_` → index (`_SPX`, `_VIX`);
- anything else → retained as a low-weight autocomplete candidate only.

**Writes**: **none to the security master.** This is the one adapter that writes no reference rows
(ARCHITECTURE §7.1: "search snapshot candidates (not master rows)"). It feeds
`refdata/universe.ts`, which merges it with SEC `company_tickers.json` and OpenFIGI to produce the
master; and `search/snapshot.ts`, which serves the client's local autocomplete index. Symbols present
only in the symbol book — no CIK, no FIGI — become instruments with `instruments.search_weight < 1`
(index members get `> 1`), so they are findable but never outrank a real security (TERM-02).

**Cadence** — `ingest/jobs/universeSymbolBook.ts`, daily 06:30 ET, `cacheTtlMs 6 h`, bucket 4 req/s.
Not in the hot set; there is no plant subject.

**Staleness tier** — no `md_lines` row (no quote line). Freshness is visible as
`config_versions('universe').updated_at` and on the SECF screen footer.

**Licence row** — `source_id 'cboe.symbolBook'`, `source_name 'Cboe Symbol Book'`,
`licence_kind 'exchange_delayed'`, `display true`, `redistribution false`, `max_tier 'eod'`,
`intrinsic_delay_min 0`, `retention_days NULL` (reference data is not aged out),
`attribution 'Symbol universe: Cboe Global Markets symbol book.'`, `rate_limit '4/s (self-imposed)'`.

**Failures and data quality** — a payload with fewer than 30,000 entries is rejected outright
(`dq_events kind 'poll_anomaly'`, `details {expected: 35618, actual}`) and the previous snapshot stays
live: a truncated universe silently breaking autocomplete for a day is the failure mode this guards.
Duplicate `name` values keep the first and raise a `field_dropped` problem. A drop of more than 2 % in
entry count day-over-day opens a `data_exceptions` row of kind `'source_conflict'` for data ops.

### 5.4 `cboe.euIndices` — European index quotes

**Endpoint** `GET https://cdn.cboe.com/api/global/european_indices/index_quotes/{CODE}.json`, `{CODE}`
being the Cboe European index code (`BUK100P`, the Cboe UK 100). **Fixture** `cboe-eu-indices`
(FIXTURES.md §cboe-eu-indices).

**Parse rules** — the payload is the §5.1 shape with three deliberate differences that the normaliser
must handle separately, which is why this is its own adapter and not a `cboe.quotes` symbol:

| Payload field | Rule |
| --- | --- |
| top-level `timestamp` `"16:59:53"` | **time only, no date.** It cannot be used as `provenance.source_ts`; `source_ts` is taken from `data.last_trade_time` instead, and the bare time is recorded in `dq_events.details` when it disagrees with it by more than 5 min. |
| `data.last_trade_time` `"2026-09-15T15:30:04.900000+00:00"` | ISO 8601 **with an explicit UTC offset** (unlike the US endpoints' naive ET) — parsed as-is to `ts.src`, sub-second precision truncated to ms. |
| `data.status` `"C"` | session hint: `C` → `closed`, `O` → `open`, `H` → `halted`. The calendar (`XLON`) remains authoritative; a disagreement raises `dq_events kind 'poll_anomaly'`. |
| `data.symbol` `"^BUK100P-SL"` / `data.index` `"BUK100P"` | `index` is the join key to `indices.code`; `symbol` is recorded as `identifiers` scheme `PROVIDER_SYMBOL`, qualifier `'cboe.euIndices'`. |
| `data.exchange_id` `115` | `exchanges.cboe_exchange_id = 115` (Cboe Europe) |
| `current_price`, `high`, `low`, `prev_day_close`, `close` | `PX_LAST`, `PX_HIGH`, `PX_LOW`, `PX_CLOSE_1D`, `PX_OFFICIAL_CLOSE` (post-close only, as §5.1) |
| `open: 0`, `bid/ask/sizes: 0`, `volume: 0`, `iv30: 0` | all dropped — a European index publishes no book, no volume and no IV |
| `seqno` | `prov.srcSeq` |

**Writes**: plant `q:<instrumentId>` for the index instrument; `quote_ticks` with `kind 'summary'`;
`eod_snapshots` at the XLON close. Feeds `WEI`.

**Cadence** — 60 s during the XLON session, 15 min outside it, from the always-on WEI seed set.
**Addition required:** ARCHITECTURE §7.1 has no job row for this source; it needs
`ingest/jobs/cboeEuIndices.ts` alongside `cboeQuotes.ts`.

**Staleness tier** — `md_lines`: `source_id 'cboe.euIndices'`, `provider_symbol 'BUK100P'`,
`line_kind 'composite'`, `intrinsic_delay_min 15`, `expected_interval_ms 60000`, `priority 10`.

**Licence row** — as §5.1 with `source_id 'cboe.euIndices'`, `source_name 'Cboe Europe Index Quotes'`,
`publisher 'Cboe Europe'`, `max_tier 'delayed'`, `intrinsic_delay_min 15`, `retention_days 400`,
`attribution 'European index values delayed at least 15 minutes. Source: Cboe Europe.'`.

**Failures and data quality** — `status 'C'` outside the XLON holiday calendar → `dq_events kind
'poll_anomaly'`. A `last_trade_time` older than the previous poll's → drop (no `seqno` regression is
needed; both checks apply). When the source is down, WEI renders the index `stale` with the last close
and its `captured_at`, never a blank row (TERM-12).

**Open question.** BRIEF §2 lists the European endpoint as `/european_indices/index_quotes/{CODE}.json`
relative to the Cboe API root, without stating whether it sits under `/api/global/delayed_quotes/` like
the other three. The URL above is the importer's assumption; `scripts/fixtures-urls.ts` is the authority
and must be corrected against the recorded capture before `npm run fixtures:import` is trusted.

### 5.5 `yahoo.chart` — intraday bars, daily history, corporate actions

**Endpoints**

```
GET https://query1.finance.yahoo.com/v8/finance/chart/{SYM}?range=1d&interval=1m        intraday
GET https://query1.finance.yahoo.com/v8/finance/chart/{SYM}?range=5y&interval=1d&events=div%7Csplit   daily + events
```

`{SYM}` is the Yahoo symbol stored in `md_lines.provider_symbol`: `AAPL`, `^GSPC`, `^FTSE`, `^TNX`,
`EURUSD=X` — percent-encoded in the canonical URL (`%5EGSPC`, `EURUSD%3DX`).
**Headers** a browser-like `User-Agent` (§2.2) — **mandatory**; `Accept: application/json`.
`v7/quote` and `quoteSummary` require a crumb and are not used (BRIEF §2).
**Fixtures** `yahoo-chart-1m`, `yahoo-chart-AAPL-1d-1m.json` (AAPL 1d/1m, 313 and 317 bars),
`yahoo-chart-SPX-5d-5m.json` (`^GSPC`), `yahoo-ftse` (`^FTSE`), `yahoo-fx` (`EURUSD=X`), `yahoo-bond`
(`^TNX`), `yahoo-chart-events` (5y/1d with `events.dividends`), `yahoo-chart-AAPL-max-1d.json`.

**Parse rules** (`providers/yahoo/parse.ts`), against `chart.result[0]`:

| Payload path | Becomes |
| --- | --- |
| `chart.error` non-null | hard failure — `{code, description}` into `ProviderHttpError`; never a silent empty series |
| `meta.symbol` | join key to `md_lines.provider_symbol` |
| `meta.currency`, `meta.exchangeTimezoneName`, `meta.priceHint`, `meta.firstTradeDate` | `instruments.currency`, calendar selection, `instruments.price_decimals`, `instruments.first_trade_date` (epoch s → date) |
| `meta.regularMarketTime` (epoch s) | `ts.src` × 1000 for the quote line |
| `meta.regularMarketPrice` | `PX_LAST` |
| `meta.regularMarketDayHigh` / `DayLow` / `regularMarketVolume` | `PX_HIGH` / `PX_LOW` / `PX_VOLUME` (volume dropped when `0` on an index or FX pair) |
| `meta.previousClose` | `PX_CLOSE_1D` (**not** `chartPreviousClose`, which is the close before the chart's first bar — `0.128` in the `range=max` fixture) |
| `meta.fiftyTwoWeekHigh` / `Low` | `PX_HIGH_52W` / `PX_LOW_52W` |
| `meta.currentTradingPeriod.{pre,regular,post}.{start,end}` | session classification for `bars_intraday.session` (`'pre'`,`'regular'`,`'post'`) and a cross-check against the calendar |
| `meta.dataGranularity` | **validated against the requested `interval`** — see the `range=max` trap below |
| `timestamp[i]` (epoch s) | `bars_intraday.bar_ts` / `bars_daily.session_date` — × 1000, bar **start** |
| `indicators.quote[0].{open,high,low,close,volume}[i]` | bar OHLCV. A `null` in any of the five (Yahoo's gap marker) drops the whole bar — never zero-filled, never forward-filled |
| `indicators.adjclose[0].adjclose[i]` | `bars_daily.src_adj_close` — reconciliation only, never served (REF-09 adjusts on read from our own `corporate_actions`) |
| `events.dividends{<ts>: {amount, date}}` | `corporate_actions(ca_type 'cash_dividend', ex_date = date→ET date, amount, currency = meta.currency, source_id 'yahoo.chart', status 'paid' when `ex_date < today` else `'announced'`, review_state 'queued')` |
| `events.splits{<ts>: {date, numerator, denominator, splitRatio}}` | `corporate_actions(ca_type = numerator > denominator ? 'split' : 'reverse_split', ex_date, ratio_new = numerator, ratio_old = denominator, details = {splitRatio}, source_id 'yahoo.chart', review_state 'queued')` |

**The `range=max` trap.** `yahoo-chart-AAPL-max-1d.json` was requested with `interval=1d` and came back
with `meta.dataGranularity: "3mo"` and 169 bars — Yahoo silently downgrades the granularity on long
ranges. The normaliser therefore compares `meta.dataGranularity` against the requested interval and, on a
mismatch, emits a `schema_drift` problem and refuses to write the bars to `bars_daily` (a quarterly bar
stored as a daily one would corrupt every chart and every return series). Full daily history is fetched
as successive `range=5y&interval=1d` windows — the shape `yahoo-chart-events` actually returns
(`dataGranularity "1d"`, 1,255 bars) — walked back with `period1`/`period2` until `meta.firstTradeDate`.

**Writes**: `bars_intraday(instrument_id, bar_interval '1m'|'5m', bar_ts, md_line_id, open, high, low,
close, volume, session, is_final, capture_ts, provenance_id)`; `bars_daily(instrument_id, session_date,
md_line_id, open, high, low, close, volume, src_adj_close, source_ts, capture_ts, provenance_id)`;
`corporate_actions` (bitemporal, `upsertVersion` on the natural key
`(instrument_id, ca_type, ex_date, source_id)`); plant `b1m:<instrumentId>` with
`BAR_TS, PX_OPEN, PX_HIGH, PX_LOW, PX_LAST, PX_VOLUME, IS_FINAL`, and a `q:` line from `meta`.
The last bar of any poll is written `is_final = false` and flipped to `true` by the next poll that
carries a later `bar_ts` — the plant never publishes a closed bar it has not seen superseded.

**Cadence and hot set** — `ingest/jobs/yahooIntraday.ts`: 60 s for `b1m:` subscribers, 5 min for the rest
of the hot set. `ingest/jobs/yahooDaily.ts`: 17:30 ET daily plus the seed backfill.
`ingest/jobs/fxIntraday.ts`: 60 s for the G10 pairs in the always-on set. Bucket 2 req/s shared across all
three, so the hot set for Yahoo is capped at ~120 symbols per minute; the scheduler's 70 % share leaves
headroom for GP/GIP read-throughs.

**Staleness tier** — `md_lines`: `source_id 'yahoo.chart'`, `provider_symbol` as in the URL,
`line_kind 'composite'`, `intrinsic_delay_min 15`, `expected_interval_ms 60000`, `priority 20` — behind
Cboe in every composite merge, so Yahoo supplies `PX_LAST` only where Cboe has no line (indices outside
the US, FX, `^TNX`) or is stale.

**Licence row**

| column | value |
| --- | --- |
| `source_id` / `source_name` | `yahoo.chart` / `Yahoo Finance chart v8` |
| `publisher` | `Yahoo` |
| `licence_kind` | `unofficial` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `false` / `true` / `false` |
| `export_allowed` / `api_allowed` | `true` / `false` — **the one source whose data does not leave through the public API** (`api_allowed false`), because the endpoint is undocumented and unlicensed; the evaluator denies it for `usage_type 'api'` with `SOURCE_TIER_CAP` |
| `max_tier` / `intrinsic_delay_min` | `delayed` / `15` |
| `retention_days` | `NULL` (the daily history is the long series) |
| `attribution` | `Historical and intraday bars: Yahoo Finance (unofficial endpoint, delayed).` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `2/s (self-imposed)` / `true` / `NULL` |
| `notes` | `Undocumented endpoint; no contract. Requires a browser-like User-Agent. v7/quote and quoteSummary need a crumb and are not used.` |

**Failures and data quality** — `200` with a zero-length body means the UA was rejected: raised as a
`ProviderHttpError` so it trips the breaker (§2.2, §2.5) instead of being read as "no data". A
`chart.error` of `Not Found` retires the md line into `data_exceptions`. Timestamp arrays whose length
differs from any of the quote arrays → whole payload rejected, `dq_events kind 'parse_error'`. Daily bars
are reconciled against `cboe.quotes` closes at 18:45 ET; divergence > 0.5 % → `cross_source_divergence`
(QA-03). A dividend or split parsed from `events` lands with `review_state 'queued'` and never adjusts a
price until a data-ops user reviews it (REF-10 dual key).

### 5.6 `yahoo.search` — autocomplete fallback

**Endpoint** `GET https://query2.finance.yahoo.com/v1/finance/search?q={QUERY}&quotesCount=8&newsCount=0`
(note `query2`, not `query1`; it shares the Yahoo token bucket). **Headers** the same browser-like UA.
**Fixture** `yahoo-search` (FIXTURES.md §yahoo-search).

**Parse rules** — `quotes[]` only; `news`, `nav`, `lists`, `researchReports`, `screenerFieldResults` and
every `timeTakenFor*` field are ignored. Per element: `symbol`, `shortname`/`longname`, `exchange`
(`"NMS"`), `exchDisp` (`"NASDAQ"`), `quoteType`, `typeDisp`, `sector`, `industry`, `score`.
`quoteType` maps to `asset_class`: `EQUITY→equity`, `ETF→etf`, `INDEX→index`, `CURRENCY→fx`,
`CRYPTOCURRENCY→crypto`, `MUTUALFUND→etf` (with a `field_dropped` problem), `FUTURE→future`; anything
else is discarded. `score` is Yahoo's, on its own scale, and is **not** merged into our ranking score —
it only orders the fallback block, which `core/command/rank.ts` appends below every local candidate.

**Writes**: **none.** This adapter is read-only by design: it is the fallback behind
`GET /api/v1/search` (FUNCTIONS §3.4) when a query of ≥ 3 characters matches nothing in the local
universe index. Results are returned to the client tagged `sourceId: 'yahoo.search'` and are not
selectable into a panel until `refdata/resolve.ts` can resolve the symbol through OpenFIGI — otherwise a
user could load a security the master has never heard of.

**Cadence** — on demand only, `cacheTtlMs 5 min` keyed on the canonical URL (so the same query from ten
users costs one request), `budgetShare: 'interactive'`. No scheduler job, no hot set.

**Staleness tier** — no `md_lines` row, no plant subject, no stored value: nothing to go stale.

**Licence row** — `source_id 'yahoo.search'`, `source_name 'Yahoo Finance search v1'`,
`licence_kind 'unofficial'`, `display true`, `non_display false`, `derived false`,
`redistribution false`, `export_allowed false`, `api_allowed false`, `max_tier 'eod'`,
`intrinsic_delay_min 0`, `retention_days NULL`,
`attribution 'Symbol lookup: Yahoo Finance.'`, `rate_limit '2/s (shared with yahoo.chart)'`,
`requires_user_agent true`.

**Failures and data quality** — any failure is swallowed into an empty fallback block: autocomplete must
never fail the keystroke path (NFR: autocomplete < 80 ms p95). The breaker still counts the failures, and
`sys:status` shows Yahoo degraded, but the command line simply shows the local candidates. A `quotes[]`
element without a `symbol` is skipped with a `field_dropped` problem.

### 5.7 `frankfurter` — ECB reference FX

**Endpoints** `GET https://api.frankfurter.dev/v1/latest?base=USD` and
`GET https://api.frankfurter.dev/v1/{from}..{to}?base=USD` for history. **Headers**
`Accept: application/json`. **Fixture** `frankfurter` (FIXTURES.md §frankfurter):
`{ amount: 1, base: "USD", date: "2026-09-15", rates: { AUD: 1.4034, …, EUR: 0.86663, GBP: 0.74166, JPY: 155, … } }`
— 30 currencies.

**Parse rules**

- `base` and `amount` are asserted: `amount !== 1` or `base !== 'USD'` is a hard parse error (the job
  always requests `base=USD` and the arithmetic below assumes it).
- `date` is the ECB reference date, a **date with no time**. It becomes `fx_rates.rate_date`,
  `bars_daily.session_date` and `provenance.source_ts` at `14:15:00Z` (the ECB's publication instant);
  `ts.src` is that same instant.
- `rates[CCY]` is quote-per-1-USD. Our instruments follow market convention
  (`fx_terms.quote_convention`), so `EURUSD` — base `EUR`, quote `USD` — is written as
  `1 / rates.EUR = 1 / 0.86663 = 1.153895…`, while `USDJPY` is `rates.JPY` unchanged. The inversion is
  driven by `fx_terms.base_ccy`/`quote_ccy`, never by a hard-coded list, and the rounding is done once at
  `numeric(18,8)`.
- Both directions are stored in `fx_rates` (`USD→EUR` and `EUR→USD`) so a cross-rate query needs no
  conditional logic; `bars_daily` gets only the conventional pair.

**Writes**: `fx_rates(base_ccy, quote_ccy, rate_date, rate, source_id 'frankfurter', provenance_id)` —
primary key `(base_ccy, quote_ccy, rate_date, source_id)`, so a re-run is a no-op;
`bars_daily(instrument_id, session_date, md_line_id, close, source_ts, capture_ts, provenance_id)` with
`open`/`high`/`low`/`volume` **left NULL** — the ECB publishes one reference fixing, not a bar, and
fabricating `open = high = low = close` would make FXC's candle chart lie. Plant: none directly; the
`q:` line for an fx instrument is Yahoo's (§5.5), with `frankfurter` supplying `PX_OFFICIAL_CLOSE` at
the end of the day.

**Cadence** — `ingest/jobs/fxEod.ts`, 16:15 CET daily (the ECB publishes around 16:00 CET), plus a
`v1/{from}..{to}` backfill at seed. `cacheTtlMs 1 h`, bucket 1 req/s.

**Staleness tier** — `md_lines`: `source_id 'frankfurter'`, `provider_symbol 'USD'`,
`line_kind 'reference'`, `intrinsic_delay_min 0`, `expected_interval_ms 86400000`, `priority 30`. With a
daily interval the 3× rule makes an fx official close stale after three missed publications, which is
the right sensitivity for a once-a-day fixing.

**Licence row** — `source_id 'frankfurter'`, `source_name 'frankfurter.dev (ECB reference rates)'`,
`publisher 'European Central Bank (via frankfurter.dev)'`,
`terms_url 'https://frankfurter.dev/'`, `licence_kind 'open_data'`, `display true`, `non_display true`,
`derived true`, `redistribution true`, `export_allowed true`, `api_allowed true`, `max_tier 'eod'`,
`intrinsic_delay_min 0`, `retention_days NULL`,
`attribution 'Exchange rates: European Central Bank reference rates via frankfurter.dev.'`,
`rate_limit '1/s (self-imposed)'`, `requires_user_agent false`, `api_key_env NULL`,
`notes 'ecb.europa.eu is not reachable from this network; frankfurter.dev mirrors the ECB daily fixing.'`
This is the only market-data source in the first half with `redistribution true` and `non_display true`:
ECB reference rates are published for reuse, which is why FXC and PORT can use them for base-currency
conversion without an entitlement downgrade.

**Failures and data quality** — `date` older than the last stored `rate_date` while today is a TARGET2
business day after 16:30 CET → `dq_events kind 'missing_close'`, `source_id 'frankfurter'`. A currency
that disappears from `rates` between runs → `field_dropped` problem plus a `data_exceptions` row of kind
`'missing_field'`. Each rate is sanity-checked against the previous stored value: a move greater than
10 % in one day on a G10 pair is persisted but flagged `dq_events kind 'cross_source_divergence'` with
the Yahoo `=X` close for the same date as the comparison.

### 5.8 `coingecko.simple` — crypto context

**Endpoint**
`GET https://api.coingecko.com/api/v3/simple/price?ids={IDS}&vs_currencies=usd&include_24hr_change=true`,
`{IDS}` a comma-separated list of CoinGecko slugs (`bitcoin,ethereum`), percent-encoded in the canonical
URL. **Headers** `Accept: application/json`. **Fixture** `coingecko-simple.json`
(FIXTURES.md §coingecko-simple.json): `{ bitcoin: { usd: 75828, usd_24h_change: -4.217368765220806 },
ethereum: { usd: 2386.91, usd_24h_change: -6.001270999715535 } }`.

**Parse rules**

- The top-level keys are the CoinGecko ids and join directly to `md_lines.provider_symbol`
  (`'bitcoin'`, `'ethereum'`) — DATA_MODEL names this convention explicitly. An id present in the
  request but absent from the response means CoinGecko does not know it: `unknown_symbol` problem, no
  update, and the md line is not marked stale (it never ticked).
- `usd` → `PX_LAST`, `quote_ticks.price`.
- `usd_24h_change` is a **percent change over a rolling 24 hours**, not against a session close. We do
  not publish it as `CHG_PCT_1D` (which the terminal defines as change against `PX_CLOSE_1D` and derives
  itself). Instead the normaliser reconstructs the implied 24-hour-ago price,
  `PX_CLOSE_1D = usd / (1 + usd_24h_change / 100)`, and `core/quote/derive.ts` produces `CHG_NET_1D` and
  `CHG_PCT_1D` from it as for every other asset class. The rolling nature is recorded in
  `field_licence`/CRYP's screen footnote so the number is not mistaken for a session change.
- The payload carries **no timestamp at all**: `ts.src = null` and `provenance.source_ts = NULL`.
  `valueState` therefore relies purely on `ts.cap` and `expected_interval_ms` for this source — the
  `q.ts.src !== null` guard in `staleness.ts` is exactly why that branch is written the way it is.
- Crypto trades continuously: `session = 'open'` at all times, from a `WEEKEND`-free 24/7 calendar entry
  (`calendars.calendar_id` for crypto is `'FX_USD'`-style always-open; `session_state` never becomes
  `'closed'`, so `valueState` never short-circuits to `'closed'`).

**Writes**: plant `q:<instrumentId>` for the crypto instruments; `quote_ticks(capture_ts, instrument_id,
md_line_id, kind 'summary', source_ts NULL, publish_ts, price, prev_close, session_state 'open',
conditions {'delayed'}, provenance_id)`. No bars (CRYP charts are built from the tick history).

**Cadence** — `ingest/jobs/crypto.ts`, 60 s, always-on (crypto is a small fixed set, not hot-set driven),
`cacheTtlMs 30 s`, bucket 1 req/s. One request covers every id, so the whole crypto universe costs one
token a minute.

**Staleness tier** — `md_lines`: `source_id 'coingecko.simple'`, `provider_symbol 'bitcoin'`,
`line_kind 'composite'`, `intrinsic_delay_min 0`, `expected_interval_ms 60000`, `priority 20`.

**Licence row** — `source_id 'coingecko.simple'`, `source_name 'CoinGecko simple price'`,
`publisher 'CoinGecko'`, `terms_url 'https://www.coingecko.com/en/terms'`, `licence_kind 'unofficial'`,
`display true`, `non_display false`, `derived true`, `redistribution false`, `export_allowed true`,
`api_allowed false`, `max_tier 'delayed'`, `intrinsic_delay_min 0`, `retention_days 400`,
`attribution 'Crypto prices: CoinGecko.'`, `rate_limit '1/s (keyless demo tier)'`,
`requires_user_agent false`, `api_key_env NULL`,
`notes 'Context only (BRIEF §1 non-goal). No source timestamp in the payload; usd_24h_change is a rolling 24h move, not a session change.'`

**Failures and data quality** — `429` is expected on the keyless tier and is retried per §2.3; five
consecutive `429`s open the breaker and CRYP renders `stale` rather than a frozen price. A price that
moves more than 30 % between two 60 s polls is persisted and flagged `dq_events kind 'poll_anomaly'`
(crypto genuinely does this, so it is a warning, not a rejection). `usd` absent while the id key is
present → `missing_field` exception. Because there is no `srcSeq` and no source timestamp, the plant
cannot dedupe by sequence: identical consecutive payloads produce no `changed` fields and therefore no
`seq` bump and no fan-out (`plant.apply` step 5), which is the intended behaviour.
