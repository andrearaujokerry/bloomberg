# PROVIDERS — data source adapters, the replay store and ingest

Every number in this terminal comes from one of the sources verified in [BRIEF.md](./BRIEF.md) §2.
This document specifies the adapter contract they all implement, the shared HTTP client that
enforces their rate limits, the replay store that lets the whole test suite run offline
(FEED-08, QA-02), the deterministic simulated feed used in development, and one subsection per
source giving its endpoints, parse rules, target tables, cadence, staleness tier, licence
registry entry and failure handling.

Response shapes referenced here are recorded in `fixtures/providers/raw/` and digested in
[FIXTURES.md](./FIXTURES.md). Table and column names are those in [CONTRACTS.md](./CONTRACTS.md) §1.2.

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
produced it. `GET /api/v1/admin/trace/:traceId` (`observability/traceQuery.ts`) and the `Ctrl+I` provenance
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

`ctx.providers.ensure(kind, key, { maxAgeMs })` (FUNCTIONS §1.4 `ReadThrough`, whose single method is
`ensure`, L274 — not `get`) is the only path by which a
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

---

## 6. Symbology adapters

`openfigi.mapping` is the only adapter that POSTs, the only one whose request body participates in the
replay key (§3.2), and the only one whose rate limit is expressed in two dimensions at once (requests per
minute **and** jobs per request). Both OpenFIGI endpoints share one `ProviderId`, one token bucket and one
`adapter_version` (`openfigi/1.0.0`); they differ only in the request shape handed to
`fetch`. Files: `providers/openfigi/adapter.ts`, `providers/openfigi/parse.ts` (ARCHITECTURE §3.3).

### 6.1 `openfigi.mapping` — `POST /v3/mapping`, the security master's spine (REF-01)

**Endpoint** `POST https://api.openfigi.com/v3/mapping`.
**Headers** `Content-Type: application/json`; `X-OPENFIGI-APIKEY: ${OPENFIGI_API_KEY}` only when the env var
is set (`licence_registry.api_key_env = 'OPENFIGI_API_KEY'`). No `User-Agent` requirement.
**Body** a JSON array of 1–10 job objects, serialised by `JSON.stringify` with no whitespace:

```json
[{"idType":"TICKER","idValue":"AAPL","exchCode":"US"},{"idType":"ID_CUSIP","idValue":"001055102"}]
```

The three `idType`s in use: `TICKER` (+`exchCode: 'US'`) for the SEC/Cboe ticker universe, `ID_CUSIP` for
N-PORT and SPDR holdings rows (§7.6, §8.1), `ID_ISIN` as the fallback when a CUSIP misses.
**Fixture** `openfigi-map` (FIXTURES.md §openfigi-map).

**Parse rules** (`providers/openfigi/parse.ts#normaliseMapping`). The response is an array **positionally
parallel to the request array**: element *i* answers job *i*. This is the single most important rule in the
adapter — the payload carries no echo of the job, so losing the index loses the identity of every row.
`normalise` therefore re-reads the jobs from `raw.body` (which the `RawRecord` preserves byte-for-byte)
rather than trusting a caller-supplied list, and refuses to emit anything when
`response.length !== jobs.length` (`schema_drift` problem, whole payload dropped).

Each element is one of `{data: [...]}`, `{warning: "..."}` or `{error: "No identifier found."}`.

| Payload field | Becomes | Rule |
| --- | --- | --- |
| `data[].shareClassFIGI` `"BBG001S5N8V8"` | `issues.share_class_figi`; `identifiers(entity_kind 'issue', scheme 'SHARE_CLASS_FIGI', value, qualifier '')` | one `issues` row per distinct share-class FIGI — the share class is the issue (DATA_MODEL §3.1) |
| `data[].compositeFIGI` `"BBG000B9XRY4"` | `instruments.composite_figi`; `identifiers(entity_kind 'instrument', scheme 'COMPOSITE_FIGI', value, qualifier '', is_primary true)` | one `instruments` row per composite, i.e. per country-level line; `exchCode 'US'` → `instruments.exch_code 'US'` |
| `data[].figi` `"BBG000B9XRY4"` | `listings.figi`; `identifiers(entity_kind 'listing', scheme 'FIGI', value, qualifier '')` | the venue-level FIGI. When `figi === compositeFIGI` the row *is* the composite record and no `listings` row is written from it |
| `data[].ticker` + `data[].exchCode` | `instruments.ticker`, `listings.local_ticker`, `listings.exch_code`; `identifiers(scheme 'TICKER_EXCH', value = ticker, qualifier = exchCode)` | `qualifier` is the OpenFIGI code (`US`, `UW`, `UN`, `UP`, `UF`, `LN`, `GR`), joined to `exchanges.bbg_exch_code` → `exchanges.mic` → `listings.mic` |
| `data[].name` `"APPLE INC"` | `issues.name`, and `issuers.name` only when no SEC row exists | SEC `company_tickers.title` wins for the issuer name (mixed case, legal form) |
| `data[].securityType` / `securityType2` | `issues.security_type` / `issues.security_type2` | `'Common Stock'`, `'ETP'`, `'REIT'`, `'Index'`, `'Spot'`, `'US GOVERNMENT'`, `'Equity Option'` — stored verbatim, never re-coded |
| `data[].marketSector` `"Equity"` | `instruments.market_sector` | the `market_sector` enum values are exactly OpenFIGI's, which is why the command grammar's sectors and the symbology agree by construction (BRIEF §5) |
| `data[].securityDescription` `"AAPL"` | dropped | duplicates `ticker` on every recorded row |
| `asset_class` | derived, not published | `securityType` → `equity` (`Common Stock`, `REIT`, `Preference`), `etf` (`ETP`, `Mutual Fund`), `index` (`Index`), `govt` (`US GOVERNMENT`), `option` (`Equity Option`), `fx` (`Spot`) |
| `{"error":"No identifier found."}` | no rows | `unknown_symbol` problem + `data_exceptions(kind 'unresolved_identifier', entity_kind 'instrument', field = idType, candidates = [{sourceId:'openfigi.mapping', provenanceId, value: idValue}])` |
| `{"warning": "..."}` | no rows | `field_dropped` problem carrying the warning text; the job is not retried in the same run |

Every row is written through `upsertVersion` (§1.5) on its entity key, so the daily refresh of an unchanged
universe writes zero versions.

**Writes**: `issuers`, `issues`, `instruments`, `listings`, `identifiers` — all bitemporal
(ARCHITECTURE §7.1, `symbologyRefresh.ts`). No plant subject, no time-series row.

**Cadence and the seeding budget.** Keyless the ceiling is 25 requests/minute × 10 jobs/request = **250
mappings/minute**, and the scheduler may take at most 70 % of any bucket (§2.2), so a background seed runs
at 17 req/min = **170 mappings/minute**. `ingest/jobs/symbologyRefresh.ts` therefore batches like this:

1. **Chunking.** The pending job list is sorted by `(idType, idValue, exchCode)` and sliced into groups of
   exactly 10; the last group may be short. Sorting is not cosmetic: the body is part of the `requestKey`
   (§3.2), so an unsorted list would produce a different key on every run and every capture would miss.
2. **Priority order**, so the terminal is usable long before the seed finishes:
   tranche A = the 504 N-PORT/SPDR S&P 500 names (≈ 51 requests, **≈ 3 minutes**);
   tranche B = the always-on seed set (WEI indices, VIX, G10 FX, benchmark Treasuries, SOFR/EFFR — most of
   which are not OpenFIGI-resolvable and are minted by their own adapters instead);
   tranche C = the remaining `sec-company-tickers.json` universe, 10,422 tickers, alphabetically
   (≈ 1,043 requests, **≈ 62 minutes** at the scheduler share).
3. **Steady state.** After the seed, a job is emitted only for a ticker that is new in
   `company_tickers.json`, or whose `identifiers` row for `COMPOSITE_FIGI` is absent or closed. That is
   typically < 50 jobs/day = 5 requests, which fits inside one minute of budget.
4. **On demand.** `refdata/resolve.ts` may raise a single-job request through the read-through (§2.6) with
   `budgetShare: 'interactive'` when a user loads a security the master does not know; the bucket refuses
   it if fewer than 30 % of tokens remain, and the command line then reports `NOT_IN_UNIVERSE`.
5. **With a key.** `OPENFIGI_API_KEY` raises the documented limits to 25 requests/6 s and 100 jobs/request;
   both are `config.ts` values (`OPENFIGI_JOBS_PER_REQUEST`, bucket capacity/refill), so the same seed drops
   to ≈ 5 minutes **without a code change** — the chunk size is read from config, not a literal.

`npm run db:seed` runs all of this in `PROVIDER_MODE=replay` against the recorded captures, so a fresh
clone gets a security master offline (BRIEF §7).

**Staleness tier** — no `md_lines` row, no plant subject. Freshness of the master is visible as
`config_versions('universe').updated_at` and in the DES footer.

**Licence row** (`providers/licences.ts`)

| column | value |
| --- | --- |
| `source_id` / `source_name` | `openfigi.mapping` / `OpenFIGI mapping and search` |
| `publisher` | `Bloomberg Finance L.P. (OpenFIGI)` |
| `terms_url` | `https://www.openfigi.com/about/terms` |
| `contract_ref` | `NULL` (DATA-01 gap) |
| `licence_kind` | `open_data` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `true` / `true` / `true` |
| `export_allowed` / `api_allowed` | `true` / `true` |
| `max_tier` / `intrinsic_delay_min` | `eod` / `0` |
| `retention_days` | `NULL` (reference data is never aged out) |
| `attribution` | `Identifiers: OpenFIGI, Bloomberg Finance L.P.` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `25/min, 10 jobs/request (keyless)` / `false` / `OPENFIGI_API_KEY` |
| `audit_obligation` | `NULL` |
| `notes` | `FIGI is an open symbology standard; identifiers are redistributable with attribution. Job arrays are chunked at 10 and sorted so the request body — and therefore the replay key — is deterministic.` |

`redistribution true` is load-bearing: it is what lets the public API return a FIGI on `/api/v1/resolve`
while Yahoo-sourced prices cannot leave through the same door (§5.5).

**Failures and data quality** — `429` is retried per §2.3 and `Retry-After` is honoured; five consecutive
`429`s open the breaker and `symbologyRefresh` resumes from the first unconfirmed chunk on the next run
(the job is idempotent, so replaying a chunk costs one request and writes nothing). `413` means a chunk
larger than the configured job ceiling escaped the chunker — a hard error, never retried, because it is a
code defect. A ticker that maps to **two** different `compositeFIGI` values for the same `exchCode` opens a
`data_exceptions` row of kind `'source_conflict'` with both candidates and their `provenance_id`s, and
neither is written until data ops resolves it (REF-10) — silently picking one would key the master on a
coin flip, which is exactly what REF-01 forbids. A `compositeFIGI` that arrives with a different
`shareClassFIGI` than the stored version is a genuine reorganisation and goes through `writeVersion` with
`reason 'change'`, closing the previous valid-time version.

### 6.2 `openfigi.mapping` — `POST /v3/search`, interactive resolution only

**Endpoint** `POST https://api.openfigi.com/v3/search`. Same `ProviderId`, same bucket, same headers.
**Body** `{"query":"apple","exchCode":"US"}`, optionally `{"start":"<cursor>"}` to page.
**Fixture** `openfigi-search` (FIXTURES.md §openfigi-search):
`{ data: [100 × {figi, name, ticker, exchCode, compositeFIGI, securityType, marketSector, shareClassFIGI, securityType2, securityDescription}], next: "QW9JSVFGL1poQ3hDUWtjd01EQXhVMUZPTVRZPSAx…" }`.

**Parse rules** — element shape is identical to §6.1, so `parse.ts` shares `normaliseRecord()`. Two
differences: the response is an **object** with `data` and an opaque `next` cursor (not a positional
array), and the result set is a relevance list, not an identity assertion. Consequences:

- results are candidates, never master rows: `normalise` returns `rows: {}` and the candidates travel back
  to `refdata/resolve.ts` in `Normalised.updates`-free form for the caller to confirm;
- a candidate is promoted to a master row only by re-issuing a `/v3/mapping` job on its `ticker`+`exchCode`
  (§6.1), which is the assertion path. Search proposes, mapping disposes;
- paging follows `next` at most 3 times (300 candidates) and then stops; an unbounded walk would spend the
  whole minute's budget on one keystroke.

**Writes**: none. **Cadence**: on demand, `cacheTtlMs 5 min` on the canonical URL + body,
`budgetShare: 'interactive'`. **Staleness tier**: none. **Licence row**: shared with §6.1 (one
`source_id`). **Failures**: any failure returns an empty candidate list; the command line falls back to
`yahoo.search` (§5.6) and then to local candidates, and never blocks the keystroke path.

---

## 7. SEC EDGAR adapters (DATA-06, NEWS-04, STOR-06)

Six `ProviderId`s share `providers/sec/adapter.ts` + `providers/sec/parse.ts` and one
`adapter_version` `'sec/1.0.0'`, because they share the header discipline, the host pair and the
bitemporal write path.

**Cross-cutting rules for every SEC adapter**

- **Headers** `User-Agent: ${SEC_USER_AGENT}` and `Accept-Encoding: gzip, deflate`. `SEC_USER_AGENT` is
  validated by the `config.ts` zod schema against `/^.+\s+\S+@\S+\.\S+$/`; the process refuses to start in
  `live`/`record` mode without it (§2.2). A default UA gets `403` with an HTML body, which the client
  reports as `ProviderHttpError`, never as "no filings".
- **Bucket** 10 req/s shared across all six, scheduler share 70 % → 7 req/s sustained for background work.
- **Two hosts.** `www.sec.gov` serves `company_tickers.json`, the 8-K atom feed and `/Archives`;
  `data.sec.gov` serves `submissions`, `companyfacts` and `frames`. They share one bucket because they
  share one fair-access policy.
- **CIK form.** `identifiers.value` and every `cik` column hold the **zero-padded 10-character** form
  (`'0000320193'`). URLs under `data.sec.gov` need the padded form (`CIK0000320193.json`); URLs under
  `/Archives/edgar/data/` need the **unpadded** form (`884394`). `core/ids/cik.ts#pad`/`#unpad` are the
  only two places that convert, because getting this backwards produces a `404` that looks like a
  delisting.
- **Full-text search (`efts.sec.gov`) is blocked from this network** (BRIEF §2) and is not used anywhere.

### 7.1 `sec.tickers` — ticker → CIK, the join that makes everything else possible

**Endpoint** `GET https://www.sec.gov/files/company_tickers.json`.
**Fixture** `sec-company-tickers.json` (FIXTURES.md §sec-company-tickers.json), 779 KB.

**Parse rules** (`providers/sec/parse.ts#normaliseTickers`). The payload is **not an array**: it is an
object whose keys are the decimal strings `"0"`…`"10421"`, each value `{cik_str, ticker, title}`.

| Payload field | Becomes | Rule |
| --- | --- | --- |
| object key `"0"`, `"1"`, … | iteration order | keys are sorted **numerically**, not lexically (`"10" < "9"` under string ordering would shuffle the output and break the golden file) |
| `cik_str` `1045810` (integer) | `issuers.cik`, `identifiers(entity_kind 'issuer', scheme 'CIK', value, qualifier '', is_primary true)` | zero-padded to 10: `'0001045810'` |
| `ticker` `"NVDA"` | join key to `instruments.ticker` / the Cboe symbol book | `'BRK-B'` keeps the SEC hyphen; the Cboe/Yahoo `.`/`-` variants are stored as separate `TICKER_EXCH` identifiers, never by rewriting this value |
| `title` `"NVIDIA CORP"` | `issuers.name` | wins over OpenFIGI's `name` (§6.1) |
| — | `issuers.entity_type` | `'company'` by default; overwritten by §7.2 for funds and sovereigns |

One `cik_str` may appear under several keys (a multi-class issuer: `GOOGL` and `GOOG`); the normaliser
groups by `cik_str` and emits **one** `issuers` row with several ticker joins. The reverse — one ticker
under two CIKs — has never appeared in a capture and raises `source_conflict`.

**Writes**: `issuers` (`upsertVersion`), `identifiers` scheme `CIK`. No instruments: the ticker→instrument
link is made by `refdata/universe.ts` when the OpenFIGI composite exists (§6.1), so a CIK never invents a
tradable line.

**Cadence** — `symbologyRefresh.ts`, daily 06:00 ET, `cacheTtlMs 6 h`, `If-None-Match` always sent. SEC
rewrites this file daily; a `304` costs no provenance row and no work.

**Staleness tier** — no `md_lines` row. Freshness is `config_versions('universe').updated_at`.

**Licence row** — the shared SEC row, see §15: `source_id 'sec.tickers'`, `source_name 'SEC company tickers'`,
`publisher 'U.S. Securities and Exchange Commission'`,
`terms_url 'https://www.sec.gov/os/webmaster-faq#developers'`, `licence_kind 'public_domain'`,
`display/non_display/derived/redistribution` all `true`, `export_allowed/api_allowed` `true`/`true`,
`max_tier 'eod'`, `intrinsic_delay_min 0`, `retention_days NULL`,
`attribution 'Company identifiers: SEC EDGAR.'`, `rate_limit '10/s'`, `requires_user_agent true`,
`api_key_env NULL`,
`audit_obligation 'SEC fair-access policy: descriptive User-Agent with a contact email on every request.'`

**Failures and data quality** — fewer than 8,000 entries → the payload is rejected
(`dq_events kind 'poll_anomaly'`, `details {expected: 10422, actual}`) and the previous master stands; the
failure mode being guarded is a truncated file quietly retiring half the universe. A ticker that
disappears is **not** deleted: its `identifiers` version is closed with `valid_to = now()` and a
`data_exceptions` row of kind `'manual_review'` is opened, because a disappearance is usually a delisting
that also needs a `corporate_actions` row (REF-09).

### 7.2 `sec.submissions` — the filing index and the issuer's own description of itself

**Endpoint** `GET https://data.sec.gov/submissions/CIK##########.json` (padded CIK).
**Fixtures** `sec-submissions-AAPL.json` (160 KB, 1,000 recent filings) and `sec-spy-submissions.json`
(48 KB, 275 filings) (FIXTURES.md §sec-submissions-AAPL.json, §sec-spy-submissions.json).

**Parse rules** (`providers/sec/parse.ts#normaliseSubmissions`) — two halves.

*Header → `issuers` (bitemporal `upsertVersion`):*

| Payload field | Column |
| --- | --- |
| `cik` `"0000320193"` | `issuers.cik` (already padded in this payload) |
| `name` `"Apple Inc."` | `issuers.name` |
| `sic` `"3571"` / `sicDescription` `"Electronic Computers"` | `issuers.sic` / `issuers.sic_description`, plus `entity_classifications(scheme 'SIC', code '3571')` |
| `fiscalYearEnd` `"0926"` | `issuers.fiscal_year_end` (`'MMDD'`) — the input to fiscal-period labelling in FA |
| `stateOfIncorporation` `"CA"` | `issuers.state_of_inc` |
| `category` `"Large accelerated filer"` | `issuers.filer_category` |
| `entityType` `"operating"` / `"other"` | `issuers.entity_type` — `'other'` + `tickers[]` + an `NPORT-P` history ⇒ `'fund'` (this is how SPY's issuer becomes a fund) |
| `website` | `issuers.website` |
| `lei` (`null` on both fixtures) | `identifiers(entity_kind 'issuer', scheme 'LEI', value, qualifier '')` **only when non-null** |
| `formerNames[]` `[{name, from, to}]` | `issuers.former_names` (jsonb) **and** `issuer_aliases(issuer_id, alias = name, kind 'former_name')` — the alias table is what the news matcher reads (§11.3) |
| `tickers[]` / `exchanges[]` | parallel arrays; `identifiers(scheme 'TICKER_EXCH', value = tickers[i], qualifier = 'US')`; `exchanges[i]` (`"Nasdaq"`, `"NYSE"`) is mapped to a MIC by a literal table and cross-checked against `listings.mic` |

*`filings.recent` → `filings`.* This object is **column-oriented**: fourteen parallel arrays of equal
length (1,000 for AAPL, 275 for SPY). The normaliser asserts every array has the same length before
zipping — a length mismatch is `schema_drift` and the whole payload is dropped, because a short array
would silently shift every subsequent filing's form type by one.

| Payload array | Column | Rule |
| --- | --- | --- |
| `accessionNumber[i]` `"0000320193-26-000020"` | `filings.accession_no` (PK) | dashed 20-char form |
| `filingDate[i]` | `filings.filed_date` | date, ET |
| `acceptanceDateTime[i]` `"2026-09-10T22:30:31.000Z"` | `filings.accepted_at` | **the public-knowledge instant** — see §7.3.2 |
| `reportDate[i]` | `filings.report_date` | may be `""` → NULL |
| `form[i]` / `core_type[i]` | `filings.form` | `'10-K'`, `'10-Q'`, `'8-K'`, `'8-K/A'`, `'4'`, `'NPORT-P'`, `'N-CEN'` |
| `items[i]` `"5.02,9.01"` | `filings.items` (`text[]`) | split on `,`, trimmed; `""` → `{}` |
| `primaryDocument[i]` | `filings.primary_doc` | see the XSL trap below |
| `primaryDocDescription[i]` | `filings.primary_doc_desc` | |
| `isXBRL[i]` / `isInlineXBRL[i]` (`0`/`1`) | `filings.is_xbrl` / `is_inline_xbrl` | integer → boolean |
| `size[i]` | `filings.size_bytes` | |
| — | `filings.url` | `https://www.sec.gov/Archives/edgar/data/<unpadded cik>/<accession with dashes removed>/<primary_doc>` |
| — | `filings.issuer_id` | resolved through `identifiers` scheme `CIK`; NULL until the issuer exists, backfilled by the next `symbologyRefresh` |
| `act[i]`, `fileNumber[i]`, `filmNumber[i]`, `isXBRLNumeric[i]` | dropped | no column; not needed by any screen |

**The XSL trap.** SPY's `primaryDocument` is `"xslFormNPORT-P_X01/primary_doc.xml"` — the path of the
*styled viewer*, not the document. Fetching it returns HTML. `filings.primary_doc` stores the value as
published, and §7.6 strips a leading `xsl<anything>/` segment before building the Archives URL.

*`filings.files[]`* (`[{name: "CIK0000320193-submissions-001.json", filingCount, filingFrom, filingTo}]`)
is the overflow index: `recent` is capped at 1,000. The job follows each overflow file
(`https://data.sec.gov/submissions/<name>`) **only** during the seed backfill and only for issuers in the
index-member set; day to day, `recent` covers everything new.

**Writes**: `issuers`, `identifiers` (LEI, TICKER_EXCH), `issuer_aliases`, `entity_classifications` (SIC),
`filings`, `fund_terms.cik`/`series_id` for fund filers.

**Cadence** — `ingest/jobs/secSubmissions.ts`, hourly per universe CIK, staggered so the 10 req/s bucket is
never saturated (one CIK per 150 ms at 7 req/s ⇒ the 504 index members refresh in ~72 s). `cacheTtlMs 0`
with `If-None-Match`; SEC serves ETags here and most hourly polls are `304`.

**Staleness tier** — no `md_lines` row. The CN/filings screens show `filings.captured_at` per row.

**Licence row** — shared SEC row (§7.1) with `source_id 'sec.submissions'`,
`source_name 'SEC submissions index'`, `attribution 'Filings: SEC EDGAR.'`.

**Failures and data quality** — `404` on a CIK that `company_tickers.json` published → `data_exceptions`
kind `'unresolved_identifier'`, and the CIK is dropped from the hourly rotation until the next
`symbologyRefresh` confirms it. A `filings.recent` whose newest `filingDate` is older than the stored
newest for that CIK → `dq_events kind 'poll_anomaly'` (a stale CDN object), and nothing is written.
`accepted_at` earlier than `filed_date` 00:00 ET → `parse_error`, row dropped: the PIT guarantee in §7.3.2
depends on that ordering.

### 7.3 `sec.companyfacts` — point-in-time fundamentals (DATA-06, STOR-06)

**Endpoint** `GET https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`.
**Fixture** `sec-companyfacts-AAPL.json` (FIXTURES.md §sec-companyfacts-AAPL.json) — **3.7 MB**, two
taxonomies (`dei`, `us-gaap`), 503 `us-gaap` concepts.

**Parse rules** (`providers/sec/parse.ts#normaliseCompanyFacts`). The shape is
`facts.<taxonomy>.<concept>.units.<unit>[]`, and every array element is one fact:

| Payload field | Column in `xbrl_facts` | Rule |
| --- | --- | --- |
| taxonomy key | `taxonomy` | only `'us-gaap'` and `'dei'` are ingested; anything else is skipped with a `field_dropped` problem |
| concept key | `concept` | e.g. `'RevenueFromContractWithCustomerExcludingAssessedTax'` |
| unit key | `unit` | `'USD'`, `'shares'`, `'USD/shares'`, `'pure'` |
| `start` | `period_start` | **absent for instant (balance-sheet) facts** → `NULL`, which is how `xbrl_facts_period_chk` distinguishes duration from instant facts |
| `end` | `period_end` | |
| `val` | `value` | `numeric(28,6)`; a non-finite number is a `parse_error` and the fact is dropped |
| `accn` | `accession_no` | joins to `filings` |
| `fy` / `fp` | `fy` / `fp` | `2026` / `'Q2'` \| `'FY'` |
| `form` | `form` | `'10-Q'`, `'10-K'`, `'8-K'`, `'20-F'` |
| `filed` `"2026-05-01"` | `filed_at` | **the point-in-time key** (STOR-06) |
| `frame` `"CY2026Q1"` | `frame` | **frequently absent** — the second element of the fixture's `Revenues` array (the nine-month duration) has no `frame`. Absent → `NULL`, never inferred |
| — | `captured_at`, `provenance_id` | from the `RawRecord` |

Three derived classifications the normaliser computes and does *not* take from the payload:

- **duration class** from `period_end − period_start`: 80–100 days ⇒ quarterly, 170–190 ⇒ half,
  260–285 ⇒ nine-month, 350–380 ⇒ annual, anything else ⇒ `other` and excluded from statement building.
  The fixture's three `Revenues` rows are exactly this problem in miniature: `2025-12-28→2026-03-28`
  (91 d, Q), `2025-09-28→2026-06-27` (272 d, nine-month), `2026-03-29→2026-06-27` (90 d, Q). Summing them
  would triple-count revenue.
- **duplicate suppression**: identical `(taxonomy, concept, unit, start, end, accn, val)` tuples appear when
  a concept is tagged twice in one filing; the first in document order is kept.
- **restatement detection**: the same `(concept, unit, start, end)` with a *later* `filed` and a different
  `val` is a restatement. It is inserted as a **new row**, never an update — `xbrl_facts` carries a WORM
  trigger (`xbrl_facts_worm`, DATA_MODEL L2245) precisely so this cannot be done wrong.

#### 7.3.1 Standardisation — the `xbrl_concept_map` seed (`mapping_version 'std-map/2026.09'`)

`seed/fundamentals.ts` loads the map below; `fin_statements` is built from it by
`ingest/jobs/secCompanyFacts.ts`. `priority` is the fallback chain (lower wins); `sign` flips the concepts
SEC tags as positive outflows; `statement` is `IS` / `BS` / `CF`.

| `standard_item` | `statement` | concepts, in priority order | `sign` |
| --- | --- | --- | --- |
| `REVENUE` | IS | `RevenueFromContractWithCustomerExcludingAssessedTax` (1) → `Revenues` (2) → `SalesRevenueNet` (3) → `RevenueFromContractWithCustomerIncludingAssessedTax` (4) | +1 |
| `COGS` | IS | `CostOfGoodsAndServicesSold` (1) → `CostOfRevenue` (2) → `CostOfGoodsSold` (3) | +1 |
| `GROSS_PROFIT` | IS | `GrossProfit` (1) | +1 |
| `RND` | IS | `ResearchAndDevelopmentExpense` (1) | +1 |
| `OPEX` | IS | `OperatingExpenses` (1) → `CostsAndExpenses` (2) | +1 |
| `OPER_INC` | IS | `OperatingIncomeLoss` (1) | +1 |
| `INT_EXP` | IS | `InterestExpense` (1) → `InterestExpenseNonoperating` (2) → `InterestIncomeExpenseNet` (3, `sign −1`) | +1 |
| `PRETAX_INC` | IS | `IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest` (1) → `IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments` (2) | +1 |
| `TAX` | IS | `IncomeTaxExpenseBenefit` (1) | +1 |
| `NET_INC` | IS | `NetIncomeLoss` (1) → `ProfitLoss` (2) | +1 |
| `EPS_BASIC` | IS | `EarningsPerShareBasic` (1) — unit `USD/shares` | +1 |
| `EPS_DIL` | IS | `EarningsPerShareDiluted` (1) — unit `USD/shares` | +1 |
| `SHARES_DIL` | IS | `WeightedAverageNumberOfDilutedSharesOutstanding` (1) — unit `shares` | +1 |
| `TOT_ASSETS` | BS | `Assets` (1) — instant | +1 |
| `TOT_LIAB` | BS | `Liabilities` (1) — instant | +1 |
| `EQUITY` | BS | `StockholdersEquity` (1) → `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest` (2) — instant | +1 |
| `CASH` | BS | `CashAndCashEquivalentsAtCarryingValue` (1) → `CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents` (2) — instant | +1 |
| `LT_DEBT` | BS | `LongTermDebtNoncurrent` (1) → `LongTermDebt` (2) — instant | +1 |
| `CFO` | CF | `NetCashProvidedByUsedInOperatingActivities` (1) → `NetCashProvidedByUsedInOperatingActivitiesContinuingOperations` (2) | +1 |
| `CAPEX` | CF | `PaymentsToAcquirePropertyPlantAndEquipment` (1) | −1 |
| `DIV_PAID` | CF | `PaymentsOfDividendsCommonStock` (1) → `PaymentsOfDividends` (2) | −1 |
| `BUYBACK` | CF | `PaymentsForRepurchaseOfCommonStock` (1) | −1 |
| `DDA` | CF | `DepreciationDepletionAndAmortization` (1) → `DepreciationAmortizationAndAccretionNet` (2) | +1 |
| `DPS` | CF | `CommonStockDividendsPerShareDeclared` (1) — unit `USD/shares` | +1 |

Rules the builder applies on top of the map:

- **First hit wins, per period, per filing.** For a given `(period_end, period_type, filed_at)` the builder
  walks the priority list and takes the first concept that has a fact; it does not average, and it does not
  fall through to a lower-priority concept for a *different* accession.
- **Two computed items.** `GROSS_PROFIT` falls back to `REVENUE − COGS` and `FCF` is always
  `CFO − |CAPEX|`; both are recorded in `fin_statements.as_reported` as
  `{"GROSS_PROFIT": {"concept": "computed:REVENUE-COGS", "value": …, "fact_id": null}}` so the FA
  "as reported" toggle can show that the issuer never tagged it.
- **Q4 derivation.** A 10-K carries only the annual duration, so `Q4 = FY − (Q1 + Q2 + Q3)` and the row is
  written with `derived_q4 = true`. FA renders a derived Q4 with a footnote; EE never treats it as an
  "actual" for a surprise calculation.
- **Every built row carries** `engine_name 'fin-standardise'`, `engine_version`, and `inputs_hash`
  = sha256 of the sorted `fact_id` list plus `mapping_version` (ANAL-08), plus `provenance_ids[]`, so a
  statement can be re-derived byte-for-byte from the facts that made it.
- A `standard_item` with no hit stays `NULL` and is reported through `PayloadMeta.unavailable` with
  reason `NO_SOURCE` — never `0`.

#### 7.3.2 How `filed_at` and `accepted_at` give point-in-time correctness (STOR-06)

`xbrl_facts.filed_at` is SEC's `filed` — a **date**. `filings.accepted_at` is `acceptanceDateTime` — a
**timestamp** (`2026-09-10T22:30:31.000Z`), which is the instant EDGAR made the document public and is
frequently *after* the filing date's close. Together they answer "what could a human have known at time
*t*", which is the only question a backtest may ask:

- The PIT read (`data/fundamentals.ts#facts(q, knownAt)`, DATA_MODEL §8.1) filters
  `filed_at <= knownAt::date` and orders `period_end DESC, period_start DESC, filed_at DESC,
  accession_no DESC` with `DISTINCT ON (period_end, period_start)` — so a restatement filed later is
  invisible to an earlier `knownAt`, and the integration test
  `server/test/integration/pit.fundamentals.test.ts` proves it on the AAPL `Revenues` CY2026Q1 fact
  (`accn 0000320193-26-000013`, `filed 2026-05-01`, 111,184,000,000) against a 2026-07-31 restatement.
- `knownAt` is **required** — there is no overload without it. Screens pass `now`, EQS backtests pass the
  historical date.
- Within a single day, `filed_at` is too coarse: a 10-Q accepted at 22:30 ET was not knowable at 16:00 ET
  that day. The tie-break is `filings.accepted_at`: `fundamentals.ts` joins `xbrl_facts.accession_no →
  filings.accepted_at` and, when the caller passes a `knownAt` with a time component inside the filing
  date, excludes facts whose `accepted_at > knownAt`. A missing `filings` row (facts ingested before the
  submissions index caught up) is treated as **not yet known** — the conservative direction.
- `fin_statements` is keyed `(issuer_id, period_end, period_type, filed_at, mapping_version)`, so a
  restatement is a new row and the old row is still readable; nothing is ever updated in place, and
  re-running the builder with a new `mapping_version` leaves the old standardisation intact for
  reproducibility.

**Writes**: `xbrl_facts` (append-only, WORM), `fin_statements` (one row per filing that changed a period).

**Cadence** — `ingest/jobs/secCompanyFacts.ts`: daily per CIK, staggered at ≤ 10 req/s; 3.7 MB per issuer
means the 504 index members cost ≈ 1.9 GB of transfer per full pass, so the job is ETag-gated
(`cacheTtlMs 0`, `If-None-Match`) and re-parses only on a `200`. Universe members outside the index set are
refreshed weekly, and any CIK with a new `10-K`/`10-Q` in `filings` is promoted to the front of the queue
by `secSubmissions.ts` the same hour.

**Staleness tier** — no `md_lines` row. FA's footer shows `fin_statements.built_at`, the source
`accession_no` and `filed_at`.

**Licence row** — shared SEC row with `source_id 'sec.companyfacts'`,
`source_name 'SEC XBRL company facts'`, `attribution 'Fundamentals: SEC XBRL company facts.'`.
`derived true` matters: `fin_statements` is our standardisation of SEC's data, stamped
`source_id 'internal.derived'` on its provenance with the SEC `provenance_id`s carried in
`provenance_ids[]`.

**Failures and data quality** — a response smaller than 100 KB for a CIK that previously returned megabytes
→ `poll_anomaly`, nothing written. A concept whose `units` object contains a unit we do not model is
skipped with `field_dropped`. `val` outside ±1e15 → `out_of_range` problem and the fact is dropped.
Cross-checks that raise `dq_events kind 'reconcile_mismatch'` (severity `warn`, never blocking):
`TOT_ASSETS ≠ TOT_LIAB + EQUITY` beyond 0.5 %; `GROSS_PROFIT ≠ REVENUE − COGS` beyond 0.5 % when all three
are tagged; `NET_INC ≠ PRETAX_INC − TAX` beyond 1 %. Field-population monitors track the share of index
members with a non-NULL `revenue`/`net_inc` for the latest complete quarter; below 90 % opens a
`data_exceptions` row of kind `'manual_review'` for the concept map (REF-10).

### 7.4 `sec.frames` — the cross-sectional cut for EQS

**Endpoint**
`GET https://data.sec.gov/api/xbrl/frames/us-gaap/{concept}/{unit}/CY{yyyy}[Q{q}][I].json`
(`I` = instant, for balance-sheet concepts: `CY2024Q4I`).
**Fixture** `sec-frames-assets.json` (FIXTURES.md §sec-frames-assets.json), 815 KB:
`{taxonomy: "us-gaap", tag: "Assets", ccp: "CY2024Q4I", uom: "USD", label, description, pts: 6264,
data: [6264 × {accn, cik, entityName, loc, end, val}]}`.

**Parse rules**

| Payload field | Column in `xbrl_frames` |
| --- | --- |
| `taxonomy` | `taxonomy` |
| `tag` | `concept` |
| `uom` | `unit` |
| `ccp` | `frame` |
| `data[].cik` (integer) | `cik`, zero-padded to 10 |
| `data[].accn` | `accession_no` |
| `data[].end` | `period_end` |
| `data[].val` | `value` |
| — | `issuer_id` resolved via `identifiers` scheme `CIK`; NULL for the ~60 % of filers outside our universe (kept: EQS percentile ranks are honest only against the full population) |
| — | `filed_at` back-filled from the matching `xbrl_facts` row `(cik, concept, unit, period_end, accession_no)` when one exists; **frames themselves carry no filed date**, which is why a frame is never the PIT source |
| `data[].entityName` | dropped, but compared against `issuers.name` when `issuer_id` resolved → `reconcile_mismatch` on a hard disagreement |
| `data[].loc`, `pts`, `label`, `description` | dropped (no column) |

`pts` is asserted equal to `data.length`; a mismatch is `schema_drift` and the payload is dropped.

**Writes**: `xbrl_frames`, PK `(taxonomy, concept, unit, frame, cik)` — a re-run is an upsert, so the weekly
job is idempotent.

**Cadence** — `ingest/jobs/secFrames.ts`, weekly (Sunday 03:00 ET), one request per
`(concept, unit, frame)` in a fixed list of ~20 EQS screening concepts × the last 8 quarters; ~160 requests
at 7 req/s ≈ 23 s. Never fetched interactively: EQS reads what is stored.

**Staleness tier** — none. EQS shows the `frame` label it screened on, so the user always knows the period.

**Licence row** — shared SEC row, `source_id 'sec.frames'`, `source_name 'SEC XBRL frames'`,
`attribution 'Cross-sectional fundamentals: SEC XBRL frames.'`.

**Failures and data quality** — `404` on a frame that does not exist yet (the current quarter before SEC
assembles it) is **expected**: it is swallowed as a `NormaliseProblem`, not a failure, and does not touch
the breaker. `pts` below 1,000 for a common concept → `poll_anomaly`.

### 7.5 `sec.atom` — the 8-K current-filings feed (NEWS-04)

**Endpoint**
`GET https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=40&output=atom`.
**Fixture** `sec-8k-atom.xml` (FIXTURES.md §sec-8k-atom.xml), 40 entries.

**Parse rules** (`providers/sec/parse.ts#normaliseAtom`). Four traps, all of them in the recorded bytes:

1. **The declared encoding is `ISO-8859-1`.** The reader decodes with `latin1` when the XML declaration
   says so, and only then parses. Decoding these bytes as UTF-8 mangles issuer names with accents into
   replacement characters that then fail the exact-name match in §11.3.
2. **`<summary type="html">` is escaped HTML inside the XML**, not markup:
   `&lt;b&gt;Filed:&lt;/b&gt; 2026-09-15 &lt;b&gt;AccNo:&lt;/b&gt; 0001213900-26-100070 &lt;b&gt;Size:&lt;/b&gt; 186 KB&lt;br&gt;Item 5.02: …`.
   It is entity-decoded **once** (a second pass would eat a literal `&amp;` in an issuer name), then
   scanned with `/Filed:<\/b>\s*(\d{4}-\d{2}-\d{2})/`, `/AccNo:<\/b>\s*(\d{10}-\d{2}-\d{6})/`,
   `/Size:<\/b>\s*([\d.]+)\s*(KB|MB)/` and `/Item\s+(\d+\.\d+):/g`.
3. **`<title>` carries the identity**: `"8-K - Aerkomm Inc. (0001590496) (Filer)"` →
   `/^(?<form>\S+(?:\/A)?) - (?<name>.+) \((?<cik>\d{10})\) \((?<role>Filer|Reporting|Subject|Issuer)\)$/`.
   The CIK in the title is already 10 digits. A title that does not match is a `parse_error` problem and
   the entry is skipped — never guessed at.
4. **`<updated>` carries an offset** (`2026-09-15T14:21:20-04:00`), unlike every other SEC timestamp;
   parsed as-is to UTC.

| Payload field | Becomes |
| --- | --- |
| `<id>` `urn:tag:sec.gov,2008:accession-number=0001213900-26-100070` | `news_items.provider_guid` (the dedupe key with `source_id`) |
| title `form` | `news_items.category`, `filings.form` |
| title `name` | matched to `issuers.name` for `filings.issuer_id`; also the headline text |
| title `cik` | `news_items.cik`, `filings.cik` |
| `<updated>` | `news_items.published_at` (FEED-05 `src`) |
| summary `Filed:` | `filings.filed_date` |
| summary `AccNo:` | `filings.accession_no` |
| summary `Size:` | `filings.size_bytes` (KB/MB → bytes) |
| summary `Item n.nn:` (all) | `filings.items`, `news_items.items_8k` |
| `<link rel="alternate" href>` | `news_items.url`, `filings.url` (the `-index.htm` landing page) |
| `<category term="8-K">` | cross-check against the title's form |
| — | `news_items.kind 'filing'`, `feed '8-K'`, `source_id 'sec.atom'`, `headline` = `"<form>: <name> — <first item description>"`, `summary` = the item descriptions joined, `machine_generated false`, `is_correction` = form ends `/A` |

**Writes**: `filings` (upsert on `accession_no`; the atom entry usually beats the hourly
`sec.submissions` poll by up to an hour, and the two agree by construction because the accession is the
key), `news_items`, `news_entity_links(entity_kind 'issuer', method 'cik', confidence 1.0)` plus the
instrument link for the issuer's primary composite (§11.3), and
`news_entity_links(entity_kind 'topic', entity_id = topics.code 'FILINGS', method 'feed_topic', 1.0)`.
Plant: `n:all`, `n:feed:8-K`, `n:inst:<id>`, `n:topic:FILINGS`.
An 8-K carrying item `5.02` also opens a `people` row candidate (`source_id 'sec.atom'`) for data-ops
review; items `2.01`/`8.01` naming a merger raise a `corporate_actions` candidate with
`review_state 'queued'` (REF-10) — never an automatic action.

**Cadence** — `ingest/jobs/secSubmissions.ts` runs the atom poll every 60 s (`cacheTtlMs 0`,
`If-None-Match`), independently of the hourly per-CIK sweep. `count=40` is one page; at 60 s the feed
cannot outrun us except during a filing storm, which is what the gap detector below is for.

**Staleness tier** — no `md_lines` row; `n:` subjects are not conflated (API §6.1) and each headline is one
delta. `sys:status` carries `sec.atom` in `PROVIDERS_DOWN` when its breaker opens.

**Licence row** — shared SEC row, `source_id 'sec.atom'`, `source_name 'SEC current filings (8-K atom)'`,
`attribution 'Filing alerts: SEC EDGAR.'`, `retention_days NULL`.

**Failures and data quality** — if **every** entry in a poll is new (no overlap with the previous poll's
`provider_guid` set), the feed advanced by more than one page between polls: a
`dq_events kind 'poll_anomaly'` is written with `details {overlap: 0}` and the job immediately re-polls
with `count=100` to close the gap. An entry whose accession already exists with a different CIK →
`data_exceptions kind 'source_conflict'`. HTML returned instead of XML (SEC's rate-limit page) is detected
by the `content-type` and the leading `<!DOCTYPE`, and raised as `ProviderHttpError` so it trips the
breaker rather than parsing to zero entries.

### 7.6 `sec.archives` — N-PORT, S&P 500 membership from the fund that tracks it (REF-07)

**Endpoints**, in two steps:

```
GET https://data.sec.gov/submissions/CIK0000884394.json          (sec.submissions, §7.2)
     → filings.recent where form == 'NPORT-P', max filingDate
     → accessionNumber '0001410368-26-089410', reportDate '2026-06-30'
GET https://www.sec.gov/Archives/edgar/data/884394/000141036826089410/primary_doc.xml   (sec.archives)
```

The accession loses its dashes for the path; the CIK is **unpadded** (`884394`); and `primaryDocument`
(`"xslFormNPORT-P_X01/primary_doc.xml"`) has its leading `xsl…/` segment stripped, because that prefix is
the styled viewer and returns HTML (§7.2).
**Fixture** `sec-nport-SPY-primary_doc.xml` (FIXTURES.md §sec-nport-SPY-primary_doc.xml), 444 KB.

**Parse rules** (`providers/sec/parse.ts#normaliseNport`), namespace
`http://www.sec.gov/edgar/nport`:

*Header:*

| Path | Becomes |
| --- | --- |
| `headerData/submissionType` `NPORT-P` | asserted; anything else is a hard `schema_drift` |
| `formData/genInfo/regName` `State Street(R) SPDR(R) S&P 500(R) ETF Trust` | cross-check against `issuers.name` for CIK 0000884394 |
| `formData/genInfo/regCik` `0000884394` | join to the fund issuer |
| `formData/genInfo/regLei` `549300NZAMSJ8FXPQQ63` | `identifiers(entity_kind 'issuer', scheme 'LEI')` |
| `formData/genInfo/repPdDate` `2026-06-30` | **`index_members.as_of_date` and `etf_holdings.as_of_date`** — the portfolio date, *not* the filing date |
| `formData/genInfo/repPdEnd` `2026-09-30` | recorded in `dq_events.details` only; it is the reporting period end, not the holdings date |
| `formData/fundInfo/totAssets` `783339902049.69` / `totLiabs` / `netAssets` `781188872106.76` | the denominator cross-check for `pctVal` |

*Holdings* — `formData/fundInfo/invstOrSecs/invstOrSec`, 504 of them:

| Element | Column in `etf_holdings` | Rule |
| --- | --- | --- |
| `name` `Aflac Inc` | `name` | also the third resolution key |
| `lei` `549300N0B7DOGLXWPP39` | `lei` | |
| `title` | dropped (equals `name` on every recorded row) | |
| `cusip` `001055102` | `cusip` | **first** resolution key |
| `identifiers/isin/@value` `US0010551028` | `isin` | second resolution key; note it is an **attribute**, not text |
| `balance` `5551377.00000000` | `shares` | only when `units == 'NS'` (number of shares); `PA` (principal amount) rows are debt and never become index members |
| `curCd` `USD` | asserted `USD` for S&P 500 rows | |
| `valUSD` `650898953.25000000` | `market_value` | |
| `pctVal` `0.083321585405` | `weight = pctVal / 100` = `0.00083321585405` | the payload is a **percent**; `index_members.weight` is a fraction (DATA_MODEL L848) |
| `payoffProfile` `Long` | filter | `Short` rows are excluded from `index_members` |
| `assetCat` `EC` | `asset_cat` | `EC` equity, `DBT` debt, `STIV` short-term investment — only `EC` becomes an index member |
| `issuerCat` `CORP` | `issuer_cat` | absent on 30 rows (they carry `issuerConditional` instead) → NULL, no problem raised |
| `invCountry` `US` | `country` | |
| `isRestrictedSec`, `fairValLevel`, `securityLending/*` | dropped (no columns) | |
| document order | `line_no` | 1-based; stable within one file, which is what makes the PK `(etf_instrument_id, as_of_date, source_id, line_no)` meaningful |

**The 505th `cusip`.** The tag histogram shows `cusip: 505` and `isin: 505` against `invstOrSec: 504` —
one `cusip`/`isin` pair lives outside the holdings list. The normaliser therefore iterates
`formData/fundInfo/invstOrSecs/invstOrSec` and reads **named child elements of each holding**; it never
does a document-wide tag scan. A whole-document `getElementsByTagName('cusip')` yields 505 values and
shifts every holding's identifier by one from that point on — a silent, total corruption of the index.
The normaliser asserts `cusipCount === holdingCount` within the scoped traversal and fails loudly if not.

**Instrument resolution**: CUSIP → ISIN → normalised name alias (DATA_MODEL §3.1 L539). An unresolved
holding still gets its `etf_holdings` row with `holding_instrument_id NULL` plus a `data_exceptions` row of
kind `'unresolved_identifier'`; it is excluded from `index_members` and from MEMB's weight sum, and the
screen shows the coverage percentage rather than pretending to 100 %.

**Writes**: `etf_holdings` (504 rows, `source_id 'sec.archives'`);
`index_members` (`index_id` of `SPX`, `instrument_id`, `weight`, `shares`, `market_value`,
`as_of_date = repPdDate`, `source_id 'sec.archives'`) written with `writeVersion`,
`valid_from = repPdDate 00:00 America/New_York`, closing the prior version for any name that left;
`issues.cusip`/`issues.isin` and `identifiers` `CUSIP`/`ISIN`/`LEI` for resolved names;
`indices.membership_source_id = 'sec.archives'` for SPX.

**Cadence** — `ingest/jobs/secNport.ts`: monthly, plus immediately on a new `NPORT-P` appearing in the
SPY submissions index (the `sec.submissions` hourly poll schedules it). `cacheTtlMs 24 h` — an Archives
document is immutable once filed, so the ETag path makes a repeat fetch free.

**Staleness tier** — no `md_lines` row. MEMB and PORT show `index_members.as_of_date` and its `source_id`
per row, and an N-PORT is structurally two months stale at publication (`repPdDate 2026-06-30` filed
`2026-08-28`) — which is exactly why §8 exists.

**Licence row** — shared SEC row, `source_id 'sec.archives'`, `source_name 'SEC EDGAR Archives (N-PORT)'`,
`attribution 'Index membership and weights: SEC Form N-PORT filings of the SPDR S&P 500 ETF Trust.'`,
`notes 'Official regulatory filing; quarterly portfolio date, filed up to 60 days later. Daily membership comes from ssga.holdings.'`

**Failures and data quality** — holding count outside 495–515 → `dq_events kind 'poll_anomaly'` and nothing
is written. `Σ pctVal` over all rows outside 99.0–100.5 → `poll_anomaly`. `Σ valUSD` disagreeing with
`netAssets` by more than 1 % → `reconcile_mismatch`. A `repPdDate` not newer than the stored
`as_of_date` → the run is a no-op (`ingest_runs.skipped += 1`), which is what makes the monthly job safe to
re-run.

---

## 8. Daily index membership and its reconciliation

### 8.1 `ssga.holdings` — the issuer's daily S&P 500 file

**Endpoint**
`GET https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx`.
**Headers** `Accept: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*`, plus the
browser-like `User-Agent` from §2.2 (the SSGA CDN serves HTML to unfamiliar agents).
**Fixture** `ssga-spy-holdings.xlsx` (FIXTURES.md §ssga-spy-holdings.xlsx), 53.2 KB — sheet 1 has a
metadata header block, then the columns `Name, Ticker, Identifier, SEDOL, Weight, Sector, Shares Held,
Local Currency`.

**Parsing an xlsx without a heavyweight dependency** (`providers/ssga/xlsx.ts`, ~150 lines, pure, fuzzed
under QA-05). An `.xlsx` is a ZIP of XML parts, and both halves are already in Node 22:

1. **ZIP directory.** Scan backwards from the tail for the End of Central Directory signature
   `PK\x05\x06` (`0x06054b50`), read the central-directory offset and entry count, then walk the central
   directory reading each entry's name, compression method, compressed/uncompressed sizes and local-header
   offset. Only three parts are needed: `xl/worksheets/sheet1.xml`, `xl/sharedStrings.xml` and
   `xl/workbook.xml` (to confirm sheet 1's name).
2. **Inflate.** Method `0` (stored) is a byte slice; method `8` (deflate) is
   `zlib.inflateRawSync(bytes)` — raw, because a ZIP member has no zlib header. No other method is
   accepted (`parse_error`).
3. **Sheet XML.** The same streaming XML reader used for N-PORT walks
   `<row r="n"><c r="A5" t="s"><v>12</v></c>…`. `t="s"` resolves the `<v>` integer through the
   `sharedStrings.xml` `<si><t>` list (concatenating `<r><t>` runs for rich text); `t="inlineStr"` reads
   `<is><t>`; no `t` means a number. **Empty cells are omitted from the XML**, so cells are addressed by
   their `r` reference (`"C7"` → column 3), never by counting siblings — counting is how a blank SEDOL
   shifts Weight into the Sector column.
4. **Determinism.** Rows are emitted in ascending `r` order regardless of file order; no locale, no
   `Date.parse`.

**Parse rules** (`providers/ssga/parse.ts`)

| Sheet content | Becomes | Rule |
| --- | --- | --- |
| metadata block rows 1–4, cell A: `Fund Name`, `Ticker Symbol`, `Holdings as of`, `Inception Date` | `as_of_date` from the value beside `Holdings as of` | parsed with an explicit `{Jan:1,…}` month table — `Date.parse("Sep 15, 2026")` is locale- and engine-dependent and is banned in normalisers (§1.2) |
| header row = the first row whose first non-empty cell is exactly `Name` | the column index map | columns are found **by header text**, never by position, so SSGA adding a column cannot silently re-map Weight |
| `Name` | `etf_holdings.name` | a row with an empty `Name` ends the table: the file ends with a disclaimer block |
| `Ticker` | `etf_holdings.ticker`; resolution key 3 | SSGA writes class shares as `BRK.B`; the resolver tries `BRK.B`, `BRK-B` and `BRK B` against `TICKER_EXCH` |
| `Identifier` | `etf_holdings.cusip`; resolution key 1 | 9 characters; SSGA publishes CUSIP here for US names |
| `SEDOL` | `etf_holdings.sedol`; resolution key 2 | |
| `Weight` `7.4123` | `etf_holdings.weight`, `index_members.weight` = `Weight / 100` | a percent, as in N-PORT |
| `Sector` `Information Technology` | `entity_classifications(scheme 'GICS', code = lookup(name))` **only when the name resolves to a seeded GICS code**; otherwise dropped | SSGA publishes the sector *name*, not the code; the code table is seeded from `wiki.sp500` (`cc_by_sa`) |
| `Shares Held` | `etf_holdings.shares`, `index_members.shares` | |
| `Local Currency` `USD` | asserted | non-USD rows are kept in `etf_holdings` and excluded from `index_members` |
| — | `etf_holdings.market_value` | NULL: the file publishes no value. `index_members.market_value` is likewise NULL for this source — deriving it from weight × net assets would invent a number |
| — | `line_no` | 1-based position in the table |

`provenance.source_ts` is the `Holdings as of` date at 16:00 America/New_York (the close the file
describes), not the fetch time.

**Writes**: `etf_holdings(source_id 'ssga.holdings')`; `index_members(source_id 'ssga.holdings')` via
`writeVersion` with `valid_from` = the as-of date's close, closing prior versions for names that left;
`indices.membership_source_id` stays `'sec.archives'` (the official source) while both are present —
`index_members.source_id` distinguishes rows, and MEMB shows which publication each weight came from.

**Cadence** — `ingest/jobs/ssgaHoldings.ts`, daily 19:00 ET, `cacheTtlMs 6 h`, bucket 1 req/s. One request
per day; the file is ~53 KB.

**Staleness tier** — no `md_lines` row. A missing file for two consecutive business days →
`dq_events kind 'missing_close'` and MEMB falls back to the newest `index_members` rows regardless of
source, with the as-of date on screen.

**Licence row**

| column | value |
| --- | --- |
| `source_id` / `source_name` | `ssga.holdings` / `SPDR S&P 500 ETF daily holdings` |
| `publisher` | `State Street Global Advisors` |
| `terms_url` | `https://www.ssga.com/us/en/intermediary/general-terms-and-conditions` |
| `licence_kind` | `vendor_terms` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `false` / `true` / `false` |
| `export_allowed` / `api_allowed` | `true` / `false` |
| `max_tier` / `intrinsic_delay_min` | `eod` / `0` |
| `retention_days` | `NULL` |
| `attribution` | `Daily holdings: State Street Global Advisors (SPDR S&P 500 ETF Trust).` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `1/s (self-imposed)` / `true` / `NULL` |
| `notes` | `Issuer publication, not a regulatory filing. Index membership is the ETF's portfolio, not S&P's index — the distinction is stated on MEMB. S&P 500 is a trademark of S&P Dow Jones Indices; no index licence is held (DATA-01 gap).` |

**Failures and data quality** — a response whose first two bytes are not `PK` (the CDN served an HTML
error page with status 200) → `ProviderHttpError` so it trips the breaker. Row count outside 495–515, or
`Σ Weight` outside 99.0–100.5, → `poll_anomaly` and nothing is written. An `as_of_date` not newer than the
stored one → no-op.

### 8.2 Reconciling SPDR against N-PORT (QA-03)

Two independent publications of the same portfolio, on different cadences, with different staleness — the
textbook case for QA-03's "reconcile continuously against at least one independent source". The check runs
at the end of `ssgaHoldings.ts` (`providers`-free, pure SQL over the two `index_members` slices) and again
in `reconcile.ts` after each new N-PORT.

**Comparison basis.** The two are compared at the **N-PORT `as_of_date`**, never at today's date: N-PORT's
`repPdDate` is a quarter end filed up to 60 days later, so comparing a June 30 filing against a September
15 SPDR file measures nothing but the passage of time. The SPDR row set for `as_of_date = repPdDate` is
retained specifically so the comparison has a partner (that is one reason `etf_holdings` is keyed by
`(etf_instrument_id, as_of_date, source_id, line_no)` rather than being overwritten daily).

| Check | Rule | On breach |
| --- | --- | --- |
| Membership symmetric difference | names in one source and not the other, matched on `holding_instrument_id` | `data_exceptions(kind 'source_conflict', entity_kind 'instrument', field 'index_member', candidates = [{sourceId:'sec.archives', provenanceId, value}, {sourceId:'ssga.holdings', provenanceId, value}])`, one row per name, SLA 2 business days (REF-10) |
| Per-name weight | `|w_nport − w_ssga| > 5 bp` | `dq_events(kind 'cross_source_divergence', severity 'warn', instrument_id, source_id 'ssga.holdings', details {expected: w_nport, actual: w_ssga, diffPct})` |
| Aggregate drift | `Σ |w_nport − w_ssga| > 50 bp` | `dq_events(kind 'cross_source_divergence', severity 'error', subject 'index_members')` — this catches a whole-file misparse, which per-name checks can miss |
| Share count | `|shares_nport − shares_ssga| / shares_nport > 1 %` | `reconcile_mismatch`, `warn` |
| Unresolved coverage | resolved holdings / total < 98 % on either source | `field_population`, `warn`, plus the MEMB footer shows coverage |

**Precedence.** For any query date *d*: rows from `ssga.holdings` win when `d ≥` the SPDR file's
`as_of_date`; rows from `sec.archives` win for `d <` the earliest SPDR file we hold. Because both write
into the same bitemporal `index_members` table with the same `(index_id, instrument_id)` exclusion key,
the precedence is implemented as ordering in the repository read (`refdata/indexMembership.ts`:
`ORDER BY as_of_date DESC, CASE source_id WHEN 'ssga.holdings' THEN 0 ELSE 1 END`), not by deleting rows —
the losing row stays queryable and `Ctrl+I` shows both.

---

## 9. Treasury curve adapters (ANAL-02)

Both Treasury endpoints are the same OData-over-Atom shape and share
`providers/treasury/adapter.ts` + `parse.ts` (`treasury/1.0.0`). The XML dialect: an Atom `<feed>` whose
`<entry><content type="application/xml"><m:properties>` holds `d:`-prefixed typed elements
(`m:type="Edm.Double"`, `Edm.DateTime`, `Edm.Int32`). A `d:` element carrying `m:null="true"`, or absent
entirely, is **missing** — never `0`.

**Shared timing discipline.** The response takes ≈ 18 s, so per §2.2 the bucket is 1 request/minute and the
timeout is 45 s; per §2.6 both adapters are declared **scheduler-only** — a read-through never triggers a
fetch, it returns what `curve_points` holds together with its real `captured_at`, and the CRVF/ICVS/GC
screens render the curve date and age. The month-scoped query
(`field_tdr_date_value_month=YYYYMM`) returns every business day of the month so far (9 entries in both
fixtures), so one fetch per day backfills any days a failure lost; `cacheTtlMs 12 h`. The job runs at
18:00 ET, well after Treasury's ~15:30 ET publication and outside any interactive peak.

### 9.1 `treasury.yieldcurve` — the par yield curve

**Endpoint**
`GET https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=YYYYMM`.
**Headers** none beyond the defaults (`Accept: application/xml`). **Fixture** `treasury-xml2`
(FIXTURES.md §treasury-xml2).

**Parse rules**

| Payload element | Becomes | Rule |
| --- | --- | --- |
| feed `<updated>` `2026-09-15T02:01:24Z` | `provenance.source_ts` | the feed's publication instant |
| `d:Id` `307` | dropped | Treasury's row id; not a stable key across months |
| `d:NEW_DATE` `2026-09-01T00:00:00` | `curve_points.curve_date` | a **naive date**: taken as the ET business date, date part only, never timezone-shifted |
| `d:BC_1MONTH` … `d:BC_30YEAR` | `curve_points.value` per tenor | percent, as published |
| `d:BC_30YEARDISPLAY` | dropped | duplicates `BC_30YEAR` on every recorded row; recorded as a cross-check (`reconcile_mismatch` when they differ) |

Tenor map (`curve_points.tenor` values are exactly the enum in DATA_MODEL L1466) and `tenor_days`:

| element | tenor | tenor_days | element | tenor | tenor_days |
| --- | --- | --- | --- | --- | --- |
| `BC_1MONTH` | `1M` | 30 | `BC_2YEAR` | `2Y` | 730 |
| `BC_1_5MONTH` | `1.5M` | 45 | `BC_3YEAR` | `3Y` | 1095 |
| `BC_2MONTH` | `2M` | 61 | `BC_5YEAR` | `5Y` | 1826 |
| `BC_3MONTH` | `3M` | 91 | `BC_7YEAR` | `7Y` | 2556 |
| `BC_4MONTH` | `4M` | 122 | `BC_10YEAR` | `10Y` | 3653 |
| `BC_6MONTH` | `6M` | 182 | `BC_20YEAR` | `20Y` | 7305 |
| `BC_1YEAR` | `1Y` | 365 | `BC_30YEAR` | `30Y` | 10958 |

**Writes**: `curve_points(curve_id 'UST_PAR', curve_date, tenor, quote_type 'par_yield',
vintage_at = capture instant, tenor_days, value, instrument_id NULL, maturity_date NULL, is_latest,
provenance_id)` — PK `(curve_id, curve_date, tenor, quote_type, vintage_at)`, so a re-run with an unchanged
value is a no-op and a revised value opens a new vintage with `is_latest` flipped on the old row.
`curves` row `UST_PAR` (`kind 'par'`, `currency 'USD'`, `day_count 'ACT/ACT'`,
`compounding 'semiannual'`, `source_id 'treasury.yieldcurve'`,
`default_interpolation 'monotone_convex'`) is seeded, not written by the adapter.
Plant `c:UST_PAR` with `TENORS` (comma string in ascending `tenor_days` order), `RATES`, `CURVE_DATE`,
`BUILD_TS`, `BUILD_ID` — one delta per rebuild, never conflated. `curve_builds` is written by
`core/curves` (ANAL-02), not by the adapter.

**Cadence** — `ingest/jobs/treasuryCurves.ts`, 18:00 ET on business days, `priority 2`,
`timeoutMs 120000` for both Treasury fetches together.

**Staleness tier** — **no `md_lines` row**: a curve is not an instrument and `valueState` does not apply to
`c:` subjects. Freshness is `CURVE_DATE` + `BUILD_TS` on the subject, and the screens show the curve date
beside the value. A curve date more than three business days behind today raises
`dq_events kind 'missing_close'`, which is the curve analogue of staleness.

**Licence row**

| column | value |
| --- | --- |
| `source_id` / `source_name` | `treasury.yieldcurve` / `US Treasury daily par yield curve` |
| `publisher` | `U.S. Department of the Treasury` |
| `terms_url` | `https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics` |
| `licence_kind` | `public_domain` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `true` / `true` / `true` |
| `export_allowed` / `api_allowed` | `true` / `true` |
| `max_tier` / `intrinsic_delay_min` | `eod` / `0` |
| `retention_days` | `NULL` |
| `attribution` | `Treasury par yields: U.S. Department of the Treasury.` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `1/min (self-imposed; ~18 s responses)` / `false` / `NULL` |
| `notes` | `Scheduler-only: the read-through never fetches this source (§2.6).` |

**Failures and data quality** — a timeout is retried at most twice (the 45 s timeout plus backoff keeps the
job inside its 120 s budget) and then leaves the previous curve in place with a `dq_events` row; the
breaker opens after five consecutive failures and `sys:status` marks `provider:treasury.yieldcurve`
degraded. A tenor missing on a day when it was present the day before → `field_population`, `warn`
(Treasury genuinely suspends tenors — the 30Y was absent 2002–2006 — so this is never a rejection).
A curve that inverts by more than 200 bp between adjacent tenors, or any value outside 0–25 %, is dropped
per point with `out_of_range`. `BC_10YEAR` is cross-checked against H.15 `RIFLGFCY10_N.B` and Yahoo `^TNX ÷ 10`
in `reconcile.ts`; divergence > 5 bp → `cross_source_divergence`.

### 9.2 `treasury.bills` — bill rates, and the on-the-run bill by CUSIP

**Endpoint** the same base URL with `data=daily_treasury_bill_rates`.
**Fixture** `treasury-bills.xml` (FIXTURES.md §treasury-bills.xml), 9 entries.

**Parse rules** — per `<m:properties>`, seven tenors (`4WK`, `6WK`, `8WK`, `13WK`, `17WK`, `26WK`, `52WK`)
each with four fields:

| Payload element | Becomes |
| --- | --- |
| `d:INDEX_DATE` `2026-09-01T00:00:00` | `curve_points.curve_date` (ET date, date part only) |
| `d:QUOTE_DATE` | cross-check against `INDEX_DATE`; a disagreement is `reconcile_mismatch` |
| `d:ROUND_B1_CLOSE_{T}_2` `3.78` | `curve_points(quote_type 'discount_rate')` — the bank-discount close |
| `d:ROUND_B1_YIELD_{T}_2` `3.87` | `curve_points(quote_type 'investment_yield')` — the coupon-equivalent yield |
| `d:MATURITY_DATE_{T}` `2026-12-03T00:00:00` | `curve_points.maturity_date`, `govt_terms.maturity_date` |
| `d:CUSIP_{T}` `912797VA2` | `govt_terms.cusip`, `instruments.ticker`, `identifiers(scheme 'CUSIP')`, and `curve_points.instrument_id` |
| `d:CS_{T}_CLOSE_AVG` / `CS_{T}_YIELD_AVG` | cross-check only — identical to the `ROUND_B1_*` values on every recorded row; a divergence raises `reconcile_mismatch` and the `ROUND_B1_*` value is published |
| `d:BOND_MKT_UNAVAIL_REASON` (empty on every recorded row) | non-empty ⇒ the whole entry is skipped with `dq_events kind 'missing_close'` carrying the reason text |
| `d:CF_NEW_DATE` `09/01/2026`, `d:CF_WEEK` `202636`, `d:DailyTreasuryBillRateDataId` | dropped |

`tenor_days`: `4WK` 28, `6WK` 42, `8WK` 56, `13WK` 91, `17WK` 119, `26WK` 182, `52WK` 364.

**Writes** — three things, which is why this adapter is the one that mints government instruments
(DATA_MODEL §3.1 L540):

1. `curve_points(curve_id 'UST_BILL', …)` for both quote types, 14 rows per business day.
2. The **security master for bills**: issuer `US Treasury` (`entity_type 'sovereign'`, seeded), one
   `issues` + `instruments` row per CUSIP (`asset_class 'govt'`, `market_sector 'Govt'`,
   `exch_code 'GOVT'`, `ticker = CUSIP`, `currency 'USD'`), `identifiers(scheme 'CUSIP')`, and
   `md_lines(source_id 'treasury.bills', provider_symbol = the tenor label '13WK', line_kind 'reference')`.
3. `govt_terms` via `upsertVersion`: `security_type 'bill'`, `cusip`, `term_label '13WK'`,
   `maturity_date`, `coupon_type 'zero'`, `coupon_rate NULL`, `day_count 'ACT/360'`,
   `settlement_days 1`, `calendar_id 'USGOVT'`, `on_the_run true`. When a new CUSIP takes over a
   `term_label`, the previous holder gets a `writeVersion` with `on_the_run false` and
   `reason 'change'` — that transition is the whole point of storing the label, and it is what SRCH and
   YAS key on.

Plant: `c:UST_BILL`; the individual bills get `q:<instrumentId>` lines only when subscribed.

**Cadence** — the same `treasuryCurves.ts` run, immediately after §9.1, sharing the 1/min bucket
(two requests ⇒ the job takes ≈ 80 s wall clock, which is why `timeoutMs` is 120 s and `priority` is 2).

**Staleness tier** — `md_lines`: `source_id 'treasury.bills'`, `provider_symbol '13WK'`,
`line_kind 'reference'`, `intrinsic_delay_min 0`, `expected_interval_ms 86400000`, `priority 30`.
The 3× rule makes a bill line stale after three missed publications.

**Licence row** — as §9.1 with `source_id 'treasury.bills'`,
`source_name 'US Treasury daily bill rates'`,
`attribution 'Treasury bill rates: U.S. Department of the Treasury.'`,
`notes 'Also the source of on-the-run bill CUSIPs and govt_terms rows.'`

**Failures and data quality** — a CUSIP that changes for a tenor without the maturity date moving forward
→ `data_exceptions kind 'source_conflict'` (usually a Treasury data-entry correction). A discount rate
above the investment yield for the same tenor (the relationship is arithmetically fixed the other way) →
`parse_error`, both values dropped: it means the CLOSE/YIELD columns were transposed.

---

## 10. Macro, rates and calendar adapters (DATA-07)

### 10.1 `fred.csv` — the keyless macro workhorse

**Endpoint** `GET https://fred.stlouisfed.org/graph/fredgraph.csv?id={SERIES}`. The JSON API needs
`FRED_API_KEY`; the CSV does not, and returns the full history (BRIEF §2).
**Headers** `Accept: text/csv`. **Fixture** `fred-DGS10.csv` (FIXTURES.md §fred-DGS10.csv) — 16,881 rows
back to 1962-01-02.

**Parse rules** (`providers/fred/parse.ts`)

| CSV content | Becomes | Rule |
| --- | --- | --- |
| header `observation_date,DGS10` | the series code is **column 2's header**, not the request parameter | asserted equal to the requested `id` (case-sensitive); a mismatch is `schema_drift` and nothing is written — FRED silently substitutes a series when an id is retired |
| `1962-01-02` | `econ_observations.obs_date` | ISO date, period **start** (monthly series carry the first of the month) |
| `4.06` | `econ_observations.value` | `numeric(20,6)` |
| `.` (FRED's missing marker) | `value NULL`, `status 'missing'` | also accepts `ND` and an empty field |
| — | `vintage_at` | the capture instant of the poll that first showed this value |
| — | `status` | `'final'` on first sight; `'revised'` when a *different* value appears for an existing `obs_date` |
| — | `is_latest` | exactly one `true` per `(series_id, obs_date)`, maintained by the ingest upsert |

**Vintage handling.** `fredgraph.csv` is a *current-vintage* series — ALFRED's vintage API needs a key — so
revisions are detected by comparison, not announced: a value differing from the stored `is_latest` row for
the same `obs_date` inserts a **new** row `(series_id, obs_date, vintage_at = captured_at)` with
`status 'revised'` and clears `is_latest` on the previous one. The full history therefore accumulates our
own vintage record from the day we start polling, which is honest about what we know: the ECO screen
labels pre-first-poll history "single vintage (no revision history before <first capture date>)".

**Writes**: `econ_series` (seeded: `series_code` = the command-line code, `source_id 'fred.csv'`,
`provider_code 'DGS10'`, `frequency`, `units`, `release_id`, `instrument_id` of the `asset_class 'econ'`
instrument, `first_obs_date`, `last_obs_date`, `last_updated_at`); `econ_observations`;
plant `e:<seriesCode>` with `VALUE PERIOD RELEASED_AT PREV REVISED STATUS` — one delta per release or
vintage.

**Cadence** — `ingest/jobs/fredSeries.ts`, daily per series at 1 req/s (bucket 1/s, `cacheTtlMs 0`,
`If-None-Match`). The full DGS10 file is 262 KB; the conditional request makes an unchanged day free.
Daily series are polled at 16:30 ET, monthly ones at 09:00 ET on their release day from
`econ_release_events`.

**Staleness tier** — `md_lines` on the econ instrument: `source_id 'fred.csv'`,
`provider_symbol = provider_code`, `line_kind 'reference'`, `intrinsic_delay_min 0`,
`expected_interval_ms` = 86,400,000 (D) / 604,800,000 (W) / 2,678,400,000 (M) / 7,948,800,000 (Q) /
31,536,000,000 (A). The 3× rule then means a daily series goes stale after three missed business days,
while a monthly one has three months of grace — and when a release is *scheduled* but not yet out, the ECO
screen shows the scheduled time rather than `stale`.

**Licence row**

| column | value |
| --- | --- |
| `source_id` / `source_name` | `fred.csv` / `FRED series (CSV)` |
| `publisher` | `Federal Reserve Bank of St. Louis` |
| `terms_url` | `https://fred.stlouisfed.org/legal/` |
| `licence_kind` | `open_data` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `true` / `true` / `false` |
| `export_allowed` / `api_allowed` | `true` / `true` |
| `max_tier` / `intrinsic_delay_min` | `eod` / `0` |
| `retention_days` | `NULL` |
| `attribution` | `Macro series: FRED, Federal Reserve Bank of St. Louis.` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `1/s (self-imposed)` / `false` / `FRED_API_KEY` (unused — the CSV path is keyless) |
| `notes` | `FRED aggregates series whose copyright belongs to the originating agency; bulk redistribution is not permitted, hence redistribution=false.` |

**Failures and data quality** — an HTML body (FRED's error page, served with status 200) is detected by the
leading `<` and raised as `ProviderHttpError`. A file whose row count drops by more than 1 % →
`poll_anomaly`, nothing written. A daily series with no new observation for three business days after
16:30 ET → `missing_close`. A revision larger than 5 σ of the series' historical revision distribution is
persisted and flagged `warn`, never rejected — large revisions are real.

### 10.2 `fred.calendar` — the ECO release calendar

**Endpoint** `GET https://fred.stlouisfed.org/releases/calendar` (HTML), plus
`GET https://fred.stlouisfed.org/releases` for the catalogue.
**Fixtures** `fred-cal` (74.7 KB, "34 economic release dates") and `fred-releases.html` (44.4 KB,
"332 releases of economic data") (FIXTURES.md §fred-cal, §fred-releases.html).

**Parse rules** (`providers/fred/parse.ts#normaliseCalendar`, using the shared tolerant tokeniser
`providers/html.ts` — a tag/text scanner, not a DOM, so there is no dependency and no scripting):

- The pages are **generated HTML with no stable ids**, so the parse is anchored on two invariants that are
  cheap to verify and loud when they break:
  1. `<meta name="description" content="34 economic release dates.">` — the expected row count is read
     from the description and compared with the number of rows actually parsed. A mismatch is
     `schema_drift`, the previous calendar stands, and a `dq_events kind 'parse_error'` names both numbers.
     This is the whole defence against silent HTML drift.
  2. every release links as `<a href="/release?rid=10">Consumer Price Index</a>` — `rid` is the stable
     `econ_releases.provider_release_id`; a row without an `rid` link is skipped.
- Rows are grouped under date headings (`<h3>`/`<td>` day cells); the date is parsed with an explicit
  month table into an ET calendar date.
- FRED's calendar publishes **no time of day**, so `scheduled_at` is the date at 08:30 ET (the modal US
  release time) with `time_known = false`; when the same release also appears in the BLS schedule
  (§10.6, which does publish a time), the BLS event wins and `time_known` becomes `true`.

**Writes**: `econ_releases(source_id 'fred.calendar', provider_release_id = rid, name, country 'US', url,
importance)` (`UNIQUE (source_id, provider_release_id)`);
`econ_release_events(release_id, scheduled_at, time_known, period_label, series_id when a headline series
is mapped, status 'scheduled', consensus NULL, consensus_unavailable_reason 'NO_SOURCE: no consensus
provider is reachable keyless (BRIEF §2)')`. `UNIQUE (release_id, scheduled_at, period_label)` makes the
daily re-parse idempotent.

**Cadence** — `ingest/jobs/econCalendar.ts`, daily 05:00 ET, `cacheTtlMs 1 h`.

**Staleness tier** — none; ECO shows each event's `scheduled_at` and whether the time is known.

**Licence row** — as §10.1 with `source_id 'fred.calendar'`, `source_name 'FRED release calendar'`,
`attribution 'Release calendar: FRED, Federal Reserve Bank of St. Louis.'`,
`display true`, `non_display false`, `export_allowed true`, `api_allowed true`.

**Failures and data quality** — the calendar is the most fragile parse in the system (HTML, no contract),
so it fails **closed**: any structural surprise leaves the previous calendar in place and opens a
`data_exceptions` row of kind `'parse_error'` assigned to data ops. ECO never shows a partially parsed day.

### 10.3 `fed.h15` — constant-maturity Treasury yields

**Endpoint**
`GET https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series={id}&lastobs=&from=&to=&filetype=csv&label=include&layout=seriescolumn`.
**Fixture** `fed-h15.csv` (FIXTURES.md §fed-h15.csv).

**Parse rules** — the file has a **six-line header block** before the data:

```
"Series Description","Market yield on U.S. Treasury securities at 1-month   constant maturity, …"
"Unit:","Percent:_Per_Year", …
"Multiplier:","1", …
"Currency:","NA", …
"Unique Identifier: ","H15/H15/RIFLGFCM01_N.B", …
"Time Period","RIFLGFCM01_N.B","RIFLGFCM03_N.B", …
2026-09-08,3.81,3.94,4.00,4.15,4.39,4.44,4.57,4.68,4.80,5.26,5.25
```

| Line | Rule |
| --- | --- |
| line 1 `Series Description` | `econ_series.name`, with the **runs of multiple spaces collapsed** (`"1-month   constant maturity"`) |
| line 2 `Unit:` `Percent:_Per_Year` | `econ_series.units 'Percent'`; any other unit is a `schema_drift` |
| line 3 `Multiplier:` | asserted `1`; a multiplier ≠ 1 would silently scale every yield |
| line 5 `Unique Identifier: ` (note the trailing space in the key) | `H15/H15/RIFLGFCY10_N.B` → the last segment is `econ_series.provider_code` |
| line 6 `Time Period` | the column order; columns are bound by **series code**, never by position |
| data rows | `econ_observations(obs_date, value)`; `ND` → `NULL` + `status 'missing'` (the 2026-09-07 row is all `ND` — a Sunday) |

Tenor map to the CMT curve: `RIFLGFCM01_N.B → 1M`, `M03 → 3M`, `M06 → 6M`, `Y01 → 1Y`, `Y02 → 2Y`,
`Y03 → 3Y`, `Y05 → 5Y`, `Y07 → 7Y`, `Y10 → 10Y`, `Y20 → 20Y`, `Y30 → 30Y`.

**Writes**: `econ_observations` for each series; `curve_points(curve_id 'UST_CMT', curve_date = obs_date,
tenor, quote_type 'cmt_yield', vintage_at, tenor_days, value, is_latest, provenance_id)`;
plant `e:<seriesCode>` and `c:UST_CMT`.

**Cadence** — `ingest/jobs/fedRates.ts`, daily 08:30 ET (H.15 publishes around 16:15 ET for the prior
business day; the morning run picks it up with the NY Fed rates in the same job). `cacheTtlMs 1 h`.

**Staleness tier** — `md_lines`: `source_id 'fed.h15'`, `provider_symbol = provider_code`,
`line_kind 'reference'`, `intrinsic_delay_min 0`, `expected_interval_ms 86400000`, `priority 30`.

**Licence row** — `source_id 'fed.h15'`, `source_name 'Federal Reserve H.15 selected interest rates'`,
`publisher 'Board of Governors of the Federal Reserve System'`,
`terms_url 'https://www.federalreserve.gov/data.htm'`, `licence_kind 'public_domain'`,
all of `display`/`non_display`/`derived`/`redistribution`/`export_allowed`/`api_allowed` `true`,
`max_tier 'eod'`, `intrinsic_delay_min 0`, `retention_days NULL`,
`attribution 'Constant-maturity Treasury yields: Federal Reserve H.15.'`,
`rate_limit '1/s (self-imposed)'`, `requires_user_agent false`, `api_key_env NULL`.

**Failures and data quality** — H.15 CMT is the independent check on the Treasury par curve (§9.1): the
same tenor from the two sources must agree within 5 bp on the same date, else
`cross_source_divergence`. A whole row of `ND` on a business day → `missing_close`.

### 10.4 `nyfed.rates` — SOFR, EFFR, OBFR, BGCR, TGCR with percentiles and volumes

**Endpoints**

```
GET https://markets.newyorkfed.org/api/rates/all/latest.json
GET https://markets.newyorkfed.org/api/rates/secured/sofr/last/{n}.json
GET https://markets.newyorkfed.org/api/rates/unsecured/effr/last/{n}.json
```

**Headers** `Accept: application/json`. **Fixtures** `nyfed-all` (6 rates), `nyfed-sofr` (5 days),
`nyfed-effr.json` (10 days) (FIXTURES.md §nyfed-all, §nyfed-sofr, §nyfed-effr.json).

**Parse rules** — `refRates[]`, one element per `(type, effectiveDate)`:

| Payload field | Column in `rate_fixings` | Plant field on `r:<rateCode>` |
| --- | --- | --- |
| `type` `"SOFR"` \| `"EFFR"` \| `"OBFR"` \| `"TGCR"` \| `"BGCR"` \| `"SOFRAI"` | `rate_code` | the subject: `r:SOFR` … |
| `effectiveDate` `"2026-09-14"` | `effective_date` | — |
| `percentRate` `3.62` | `rate` | `RATE` |
| `percentPercentile1` / `25` / `75` / `99` | `pct_1` / `pct_25` / `pct_75` / `pct_99` | `RATE_P1` / `RATE_P25` / `RATE_P75` / `RATE_P99` |
| `volumeInBillions` `2861` | `volume_bn` | `RATE_VOLUME_BN` |
| `targetRateFrom` `3.5` / `targetRateTo` `3.75` | `target_from` / `target_to` | `TARGET_FROM` / `TARGET_TO` — **EFFR only**; present on no other type |
| `average30day` / `average90day` / `average180day` | `avg_30d` / `avg_90d` / `avg_180d` | — |
| `index` `1.25884091` | `index_value` | — |
| `revisionIndicator` `""` | `revision_indicator` | — |
| — | `vintage_at` | capture instant; **a non-empty `revisionIndicator` always opens a new vintage** even when the value is unchanged |
| — | `is_latest` | exactly one `true` per `(rate_code, effective_date)` |

`SOFRAI` (the SOFR Averages and Index) is the odd one: it carries **no `percentRate`** and no percentiles,
only the three averages and the index level. `rate` stays `NULL` and the `r:SOFRAI` subject publishes no
`RATE` field — the screen shows `—`, which is correct, rather than a fabricated zero.

**Writes**: `rate_fixings` (PK `(rate_code, effective_date, vintage_at)`); `econ_observations` for the
headline series behind each rate (`rate_terms.series_id`); `rate_terms` seeded per rate
(`rate_code`, `publisher 'NY Fed'`, `day_count 'ACT/360'`, `publication_time_et '08:00'`,
`tenor_days 1`, `compounding 'simple'`); `curve_points(curve_id 'SOFR_FIX', curve_date = effective_date,
tenor 'ON', quote_type 'fixing', value, is_latest)`; plant `r:SOFR`, `r:EFFR`, `r:OBFR`, `r:TGCR`,
`r:BGCR`, `r:SOFRAI` and `c:SOFR_FIX`. BTMM and WIRP read these; WIRP derives the implied policy path from
the SOFR fixing plus the bill curve (BRIEF §2) rather than from fed-funds futures.

**Cadence** — `ingest/jobs/fedRates.ts`, daily 08:30 ET (NY Fed publishes SOFR at ~08:00 ET); `/latest.json`
in one request covers all six types, and the `last/{n}.json` endpoints are used only for the seed backfill
and to pick up revisions (n = 10). `cacheTtlMs 0` with `If-None-Match`.

**Staleness tier** — `md_lines`: `source_id 'nyfed.rates'`, `provider_symbol = the type` (`'SOFR'`),
`line_kind 'composite'`, `intrinsic_delay_min 0`, `expected_interval_ms 86400000`, `priority 10`.
`intrinsic_delay_min 0` is real here: these are published fixings, not delayed quotes, and the entitlement
evaluator can grant `realtime` on them where it cannot on any exchange source.

**Licence row**

| column | value |
| --- | --- |
| `source_id` / `source_name` | `nyfed.rates` / `NY Fed reference rates` |
| `publisher` | `Federal Reserve Bank of New York` |
| `terms_url` | `https://www.newyorkfed.org/markets/reference-rates/terms-of-use-for-market-data` |
| `licence_kind` | `open_data` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `true` / `true` / `false` |
| `export_allowed` / `api_allowed` | `true` / `true` |
| `max_tier` / `intrinsic_delay_min` | `realtime` / `0` |
| `retention_days` | `NULL` |
| `attribution` | `Reference rates: Federal Reserve Bank of New York.` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `1/s (self-imposed)` / `false` / `NULL` |
| `audit_obligation` | `NY Fed Terms of Use: attribution required; using SOFR as a benchmark in a financial product requires a separate licence, which we do not hold — the terminal displays and analyses the rate only.` |

**Failures and data quality** — an `effectiveDate` older than the stored latest for a type, with an empty
`revisionIndicator`, is dropped (a cached edge response). A rate moving more than 50 bp day over day on
SOFR/EFFR → `poll_anomaly`, `warn`, persisted (this happens at quarter ends). `percentPercentile1 >
percentRate` or `percentPercentile99 < percentRate` → `parse_error`, percentiles dropped, the rate kept.
No publication by 12:00 ET on a business day → `missing_close`, `error`, and `sys:status` shows the rates
line degraded.

### 10.5 `bls.timeseries` — 25 queries a day, and what that forces

**Endpoint** `POST https://api.bls.gov/publicAPI/v2/timeseries/data/`.
**Headers** `Content-Type: application/json`.
**Body** `{"seriesid":["CUUR0000SA0","CES0000000001",…],"startyear":"2016","endyear":"2026"}`.
**Fixture** `bls-cpi.json` (FIXTURES.md §bls-cpi.json).

**The scheduling implication.** The keyless v2 tier allows **25 queries per day** (and up to 25 series ids
per query, 10 years of history). The consequence is designed for, not worked around:

- `ingest/jobs/blsSeries.ts` issues **exactly one POST per day**, carrying every headline series id in a
  single `seriesid` array. One query, not one per series.
- The daily bucket is persisted in `schema_meta` (key `bucket:bls.timeseries:<yyyy-mm-dd>`) so a process
  restart does not reset it (§2.2) — the single most likely way to breach a daily quota is a crash loop.
- The scheduler's 70 % share of a 25/day bucket is 17; the job's one query plus the seed backfill's
  10-year windows stay inside it, leaving ≥ 8 for interactive and manual use.
- Consequently **BLS is never on the interactive path**: ECO and the `e:` subjects read
  `econ_observations`, and a read-through for a BLS series never fetches. A user cannot spend the day's
  quota by pressing `GO`.
- The poll is timed to the release calendar (§10.6), not to a fixed hour: 08:35 ET on a day when a BLS
  release is scheduled, and once at 09:00 ET otherwise.

**Parse rules**

| Payload field | Becomes | Rule |
| --- | --- | --- |
| `status` `"REQUEST_SUCCEEDED"` | gate | **BLS returns HTTP 200 with `status: "REQUEST_NOT_PROCESSED"` when the quota is exhausted or a series id is bad.** Anything other than `REQUEST_SUCCEEDED` is raised as `ProviderHttpError(status 200)` so it trips the breaker and burns no further quota, exactly as the Yahoo empty-body rule does (§2.2) |
| `message[]` | `dq_events.details.messages` | BLS's warnings ride here even on success |
| `Results.series[].seriesID` `"CUUR0000SA0"` | join to `econ_series.provider_code` | |
| `data[].year` + `data[].period` | `econ_observations.obs_date` | `M01`–`M12` → the 1st of that month; `Q01`–`Q04` → the quarter's first day; `A01` → January 1; **`M13` (annual average) is skipped** with a `field_dropped` problem — treating it as a 13th month corrupts every monthly chart |
| `data[].periodName` `"August"` | cross-check against the parsed period | |
| `data[].value` `"334.980"` (a **string**) | `value numeric(20,6)` | `"-"` → `NULL` + `status 'missing'` |
| `data[].footnotes[0].text` | `econ_observations.footnote` | e.g. `"Data unavailable due to the 2025 lapse in appropriations"` (fixture row 2025-M10); `footnotes: [{}]` (an empty object) is the normal case and yields NULL |
| `data[].latest` `"true"` | ignored for storage | our own `is_latest` is per `(series_id, obs_date)` and is maintained by the upsert |
| — | `status` | `'final'`; `'revised'` when the value for an existing `obs_date` changes (BLS revises CPI seasonals annually) |

**Writes**: `econ_series` (seeded), `econ_observations`, plant `e:CUUR0000SA0`.

**Staleness tier** — `md_lines`: `source_id 'bls.timeseries'`, `provider_symbol = the series id`,
`line_kind 'reference'`, `intrinsic_delay_min 0`, `expected_interval_ms 2678400000` (monthly),
`priority 30`.

**Licence row** — `source_id 'bls.timeseries'`, `source_name 'BLS public data API v2'`,
`publisher 'U.S. Bureau of Labor Statistics'`, `terms_url 'https://www.bls.gov/developers/'`,
`licence_kind 'public_domain'`, `display/non_display/derived/redistribution` all `true`,
`export_allowed/api_allowed` `true`/`true`, `max_tier 'eod'`, `intrinsic_delay_min 0`,
`retention_days NULL`, `attribution 'Labour statistics: U.S. Bureau of Labor Statistics.'`,
`rate_limit '25 queries/day (keyless)'`, `requires_user_agent false`,
`api_key_env 'BLS_API_KEY'` (unused in v1),
`notes 'Daily quota persisted in schema_meta; never on the interactive path.'`

**Failures and data quality** — quota exhaustion is a `ProviderHttpError`, not a parse of an empty result,
so it opens the breaker and `sys:status` reports BLS degraded for the rest of the day. A series returning
zero observations while `status` is `REQUEST_SUCCEEDED` → `field_population`, `warn`. CPI from BLS is
cross-checked against FRED's `CPIAUCSL`/`CPIAUCNS` for the same month: divergence beyond 0.01 index points
→ `cross_source_divergence` (the two are the same underlying series, so any divergence is a mapping bug).

### 10.6 `bls.schedule` — release times for ECO

**Endpoint** `GET https://www.bls.gov/schedule/news_release/{month}{yy}.htm`
(e.g. `september26.htm` — "Schedule of Selected Releases for September 2026").
**Fixture** `bls-schedule.html` (FIXTURES.md §bls-schedule.html), 55.9 KB.

**Parse rules** — the shared HTML tokeniser walks the release `<table>`: each row carries a date, a time
(`"08:30 AM"`), the release name and the reference period. The time is ET and is converted to UTC with the
ET calendar (so a release inside DST and one outside map correctly). `time_known = true` for every BLS
row — this is the source that upgrades FRED's 08:30 default (§10.2). Structural assertion: the page
`<title>` must contain the requested month and year, and at least 5 rows must parse; otherwise
`schema_drift` and the previous schedule stands.

**Writes**: `econ_releases(source_id 'bls.schedule', provider_release_id 'cpi' | 'empsit' | …, name,
country 'US', url, importance)`; `econ_release_events(release_id, scheduled_at, time_known true,
period_label 'August 2026', series_id, status 'scheduled')`. When the actual value lands from §10.5, the
event's `actual`, `prior` and `revised_prior` are filled and `status` becomes `'released'` (or
`'revised'`); `consensus` stays NULL with
`consensus_unavailable_reason 'NO_SOURCE: no consensus provider reachable keyless (BRIEF §2)'`.

**Cadence** — `econCalendar.ts`, daily 05:00 ET, current month + next month, `cacheTtlMs 6 h`.
**Staleness tier** — none. **Licence row** — as §10.5 with `source_id 'bls.schedule'`,
`source_name 'BLS release schedule'`, `attribution 'Release schedule: U.S. Bureau of Labor Statistics.'`.
**Failures** — fails closed like §10.2: the previous schedule stays, a `data_exceptions` row of kind
`'parse_error'` goes to data ops.

### 10.7 `worldbank` — annual global macro

**Endpoint**
`GET https://api.worldbank.org/v2/country/{ISO2}/indicator/{ID}?format=json&per_page=100&page={n}`.
**Fixture** `worldbank` (FIXTURES.md §worldbank) — captured with `per_page=3`.

**Parse rules** — the response is a **two-element array**, `[meta, data[]]`:

| Payload | Becomes |
| --- | --- |
| `[0]` `{page: 1, pages: 22, per_page: 3, total: 66, sourceid: "2", lastupdated: "2026-07-13"}` | paging control; `lastupdated` → `provenance.source_ts` and `econ_series.last_updated_at` |
| `[1][].indicator` `{id: "NY.GDP.MKTP.CD", value: "GDP (current US$)"}` | `econ_series.provider_code` / `econ_series.name` |
| `[1][].country` `{id: "US", value: "United States"}` / `countryiso3code` `"USA"` | `econ_series.country` (ISO-2) |
| `[1][].date` `"2025"` | `econ_observations.obs_date` = `2025-01-01` (annual series are stamped at the period start) |
| `[1][].value` `30769700000000` | `econ_observations.value`; `null` → `status 'missing'` |
| `[1][].obs_status` | `econ_observations.status` when non-empty (`'preliminary'`) |
| `[1][].unit`, `[1][].decimal` | `econ_series.units` (when non-empty), `econ_series.decimals` |

Two shape traps: (1) an error is returned as a **one-element** array `[{message: [...]}]` with HTTP 200 —
any response that is not a 2-tuple whose `[1]` is an array is raised as `ProviderHttpError(200)`;
(2) `pages` must be walked ascending with `&page=n` — the job uses `per_page=100` so a 66-observation
series is one request, and caps the walk at 10 pages.

**Writes**: `econ_series`, `econ_observations`. **Cadence** — `ingest/jobs/worldMacro.ts`, weekly
(Sunday 04:00 ET), `cacheTtlMs 24 h`, bucket 1 req/s. **Staleness tier** — `md_lines`:
`source_id 'worldbank'`, `provider_symbol = 'NY.GDP.MKTP.CD'`, `line_kind 'reference'`,
`expected_interval_ms 31536000000`, `priority 30`.

**Licence row** — `source_id 'worldbank'`, `source_name 'World Bank open data'`, `publisher 'World Bank'`,
`terms_url 'https://datacatalog.worldbank.org/public-licenses'`, `licence_kind 'open_data'`,
`display/non_display/derived/redistribution` all `true`, `export_allowed/api_allowed` `true`/`true`,
`max_tier 'eod'`, `intrinsic_delay_min 0`, `retention_days NULL`,
`attribution 'Global indicators: World Bank Open Data (CC BY 4.0).'`,
`rate_limit '1/s (self-imposed)'`, `requires_user_agent false`, `api_key_env NULL`.

**Failures and data quality** — a series whose latest year goes backwards → `poll_anomaly`. World Bank GDP
for the US is cross-checked against FRED `GDP` for the same year; divergence > 1 % →
`cross_source_divergence`, `info` (the two use different vintages and revisions, so this is informational).

### 10.8 `imf.datamapper` — IMF WEO annual series

**Endpoints** `GET https://www.imf.org/external/datamapper/api/v1/indicators` (the catalogue) and
`GET https://www.imf.org/external/datamapper/api/v1/{ID}/{ISO3}` (the observations).
**Fixture** `imf-weo.json` (FIXTURES.md §imf-weo.json) — this is the **catalogue**, not observations:
`{indicators: {NGDP_RPCH: {label: "Real GDP growth", description, source: "World Economic Outlook (April 2026)", unit: "Annual percent change", dataset: "WEO", "last-modified": "2026-04-08 16:07:34"}, NGDPD: {…}, …}}`.

**Parse rules**

| Payload | Becomes |
| --- | --- |
| `indicators.<ID>.label` | `econ_series.name` |
| `indicators.<ID>.unit` `"Annual percent change"` | `econ_series.units` |
| `indicators.<ID>.dataset` `"WEO"` | recorded in `econ_releases.name` (`'IMF World Economic Outlook'`) |
| `indicators.<ID>."last-modified"` `"2026-04-08 16:07:34"` | `econ_series.last_updated_at` — a naive timestamp read as UTC; the hyphenated key needs bracket access, and a dotted-path reader would return `undefined` silently |
| `indicators.<ID>.source` `"World Economic Outlook (April 2026)"` | the vintage label shown on the screen — WEO is published twice a year and the label is the only vintage marker |
| observations endpoint `values.<ID>.<ISO3>.{"2025": 2.1, …}` | `econ_observations(obs_date = YYYY-01-01, value)`; keys sorted ascending before emission |
| observation years beyond the current year | stored with `status 'preliminary'` — WEO publishes forecasts out five years, and they must never be presented as actuals |

**Writes**: `econ_series` (from the catalogue), `econ_observations` (from the per-indicator endpoint).
**Cadence** — `worldMacro.ts`, weekly, `cacheTtlMs 24 h`.
**Staleness tier** — `md_lines` as §10.7 with `source_id 'imf.datamapper'`.

**Licence row** — `source_id 'imf.datamapper'`, `source_name 'IMF DataMapper'`,
`publisher 'International Monetary Fund'`,
`terms_url 'https://www.imf.org/external/terms.htm'`, `licence_kind 'vendor_terms'`,
`display true`, `non_display false`, `derived true`, `redistribution false`,
`export_allowed true`, `api_allowed false`, `max_tier 'eod'`, `intrinsic_delay_min 0`,
`retention_days NULL`, `attribution 'Forecasts and annual macro: IMF World Economic Outlook.'`,
`rate_limit '1/s (self-imposed)'`, `requires_user_agent false`, `api_key_env NULL`,
`notes 'WEO values beyond the current year are forecasts and are stored with status=preliminary.'`

**Failures and data quality** — **addition required**: the 50 recorded files contain the indicator
catalogue but **no observation capture**, so the `values.*` path has no fixture and cannot be replay-tested
today. `scripts/fixtures-urls.ts` must gain
`imf-datamapper-NGDP_RPCH-USA.json → https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/USA`
and the file must be recorded before `worldMacro.ts` can be covered by QA-02. Until then the job runs the
IMF half only in `live`/`record` mode and the replay suite exercises the catalogue parse alone.

### 10.9 `fed.fomc` — meeting calendar

**Endpoint** `GET https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` (HTML).
**Fixture** — **none recorded**; see §16.

**Parse rules** — the shared tokeniser reads the year panels: each meeting is a month + day range
(`"January 27-28"`), with `*` marking an associated Summary of Economic Projections. Two-day meetings take
the **second** day as `fomc_meetings.meeting_date` (the decision day); `statement_at` is that date at
14:00 ET; `has_sep` from the marker. `decision_bp` is left NULL and filled after the meeting by
`fed.rss` (§11.2) when a press release with category `Monetary Policy` names a new target range.

**Writes**: `fomc_meetings(meeting_date, statement_at, has_sep, decision_bp, provenance_id)`;
`econ_releases(source_id 'fed.fomc', provider_release_id 'FOMC', name 'FOMC statement')` and one
`econ_release_events` row per meeting.
**Cadence** — `econCalendar.ts`, daily 05:00 ET, `cacheTtlMs 24 h`.
**Licence row** — shared with `fed.rss` (§11.2) under `source_id 'fed.fomc'`,
`licence_kind 'public_domain'`, all permissions `true`, `max_tier 'eod'`,
`attribution 'FOMC calendar: Federal Reserve Board.'`
**Failures** — fails closed: fewer than 8 meetings parsed for a year → `schema_drift`, previous calendar
stands.

---

## 11. News adapters (NEWS-01, NEWS-02)

### 11.1 `bbg.rss` — six Bloomberg feeds

**Endpoints** — six, one per feed:

```
https://feeds.bloomberg.com/markets/news.rss        → 301 → https://www.bloomberg.com/feeds/markets/news.rss
https://feeds.bloomberg.com/economics/news.rss      → 301 → https://www.bloomberg.com/feeds/economics/news.rss
https://feeds.bloomberg.com/politics/news.rss       → 301 → …/politics/news.rss
https://feeds.bloomberg.com/technology/news.rss     → 301 → …/technology/news.rss
https://feeds.bloomberg.com/wealth/news.rss         → 301 → …/wealth/news.rss
https://feeds.bloomberg.com/industries/news.rss     → 301 → …/industries/news.rss
```

**Redirects.** The client follows at most 3 redirections and refuses any hop that leaves
`*.bloomberg.com`. `RawRecord.url` is the **post-redirect** canonical URL (§1.1), so the `requestKey` is
computed on the `www.bloomberg.com/feeds/...` form; `scripts/fixtures-urls.ts` must therefore record the
redirected URL, not the `feeds.bloomberg.com` one, or every capture misses.
**Headers** `Accept: application/rss+xml, application/xml`, the browser-like `User-Agent` from §2.2.
**Fixtures** `bbg-rss-markets`, `bbg-rss-econ`, `bbg-rss-politics`, `bbg-rss-tech`,
`bbg-rss-industries` — 20 items each (FIXTURES.md §bbg-rss-*). **Addition required:** the `wealth` feed
has no recorded capture (five of six are present).

**Parse rules** (`providers/bbgRss/parse.ts`), RSS 2.0 with `dc`, `content`, `atom` and `media`
namespaces; every text node is `<![CDATA[…]]>`:

| Payload | Becomes | Rule |
| --- | --- | --- |
| `channel/lastBuildDate` `"Tue, 15 Sep 2026 18:39:00 GMT"` | `provenance.source_ts` | RFC 822, parsed with explicit month and zone tables — never `new Date(string)` (§1.2) |
| `channel/language` `"en"` | `news_items.lang` | |
| `channel/copyright` | recorded in `licence_registry.notes`, not per row | |
| `item/guid` `"TLEXF6KK3NYB00"` (`isPermaLink="false"`) | `news_items.provider_guid` | the dedupe key with `source_id` |
| `item/title` | `news_items.headline` | CDATA unwrapped, entities decoded **once**, C0 control characters stripped, whitespace collapsed; typographic quotes and em dashes preserved as published |
| `item/description` | `news_items.summary` | any HTML stripped to text; the **article body is never fetched or stored** (feed terms; DATA_MODEL L1569) |
| `item/link` | `news_items.url` | |
| `item/dc:creator` `"Yash Roy"` | `news_items.author`, and a `people` candidate (`role 'Reporter'`, `source_id 'bbg.rss'`) | |
| `item/pubDate` | `news_items.published_at` (FEED-05 `src`) | |
| the feed name | `news_items.feed` (`'markets'`, `'economics'`, …) | |
| — | `news_items.kind` | `'video'` when the link path contains `/news/videos/`, else `'story'` |
| — | `news_items.is_correction` | `/^(correct|corrects|correction|fixes headline)\b/i` on headline or summary |
| — | `news_items.machine_generated` | `false` — always, in v1 (NEWS-08); the column exists so the render rule is enforceable later |
| — | `news_items.cik`, `items_8k`, `category` | NULL for this source |

**Deduplication by guid.** `news/ingest.ts` upserts on the `UNIQUE (source_id, provider_guid)` key:

```sql
INSERT INTO news_items (source_id, feed, provider_guid, kind, headline, summary, url, author, lang,
                        published_at, captured_at, is_correction, machine_generated, provenance_id)
VALUES (…)
ON CONFLICT (source_id, provider_guid) DO UPDATE
   SET headline = EXCLUDED.headline, summary = EXCLUDED.summary, url = EXCLUDED.url,
       published_at = EXCLUDED.published_at, is_correction = EXCLUDED.is_correction,
       provenance_id = EXCLUDED.provenance_id
 WHERE news_items.headline IS DISTINCT FROM EXCLUDED.headline
    OR news_items.summary  IS DISTINCT FROM EXCLUDED.summary
 RETURNING news_id, (xmax = 0) AS inserted;
```

A plant `n:` delta is emitted only when `inserted` is true or the headline actually changed — so
re-polling the same 20 items every 60 s produces no fan-out, while a re-titled story produces exactly one
update. `n:` subjects are never conflated (API §6.1): headlines arrive in `published_at` order, one delta
each, and a later headline never overwrites an earlier one.

**The cross-feed duplicate.** All six feeds share `source_id 'bbg.rss'`, and `feed` is **not** part of the
unique key, so a story appearing in both `markets` and `economics` is **one row**, and the first feed
polled owns the `feed` column. That is deliberate — one story, one row, one `news_id` for every link and
alert — but it would make `n:feed:economics` incomplete. The fix is at the link layer: on every poll,
whether or not the row was inserted, the ingester upserts
`news_entity_links(news_id, entity_kind 'topic', entity_id = topics.code for that feed, confidence 1.0,
method 'feed_topic')`. Topic subjects are therefore complete even when the `feed` column is first-wins, and
`n:topic:ECO` is the subject the ECO screen subscribes to, not `n:feed:economics`.

**Writes**: `news_items`, `news_entity_links` (§11.3), `people` candidates; plant `n:all`,
`n:feed:<feed>`, `n:topic:<code>`, `n:inst:<instrumentId>`.

**Cadence** — `ingest/jobs/newsRss.ts`, 60 s per feed, round-robin so the six feeds cost one request per
10 s; `cacheTtlMs 0` with `If-None-Match` (Bloomberg serves ETags and most polls are `304`).

**Staleness tier** — no `md_lines` row. A feed with no new item for 6 hours during US market hours →
`dq_events kind 'stale_tick'`, `source_id 'bbg.rss'`, `subject 'n:feed:<feed>'`.

**Licence row**

| column | value |
| --- | --- |
| `source_id` / `source_name` | `bbg.rss` / `Bloomberg RSS news feeds` |
| `publisher` | `Bloomberg L.P.` |
| `terms_url` | `https://www.bloomberg.com/notices/tos/` |
| `contract_ref` | `NULL` (DATA-01 gap: public feed, no agreement) |
| `licence_kind` | `vendor_terms` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `false` / `false` / `false` |
| `export_allowed` / `api_allowed` | `false` / `false` |
| `max_tier` / `intrinsic_delay_min` | `eod` / `0` |
| `retention_days` | `NULL` |
| `attribution` | `Headlines: Bloomberg. Copyright 2026 BLOOMBERG L.P. All rights reserved.` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `1/s (self-imposed)` / `true` / `NULL` |
| `audit_obligation` | `Headline, summary and link only; no body text is stored or served. Display-only: export and API are denied by the evaluator with SOURCE_TIER_CAP.` |

`export_allowed false` and `api_allowed false` are enforced, not advisory: N/NI/TOP render headlines on
screen, `toCsv` omits every `bbg.rss` row and the CSV header carries the omission reason, and
`/api/v1/news` returns those rows with `headline` denied per-field (ENTL-05).

**Failures and data quality** — a `301` chain leaving `bloomberg.com` is a hard failure (a hijacked feed
must not be parsed). Zero `<item>` elements in a well-formed feed → `poll_anomaly`, `warn`. A `pubDate`
more than 24 h in the future → the item is dropped with `out_of_range` (a bad timestamp would pin the item
to the top of every stream forever). An item whose `guid` already exists with a **different `link` host**
→ `data_exceptions kind 'source_conflict'`.

### 11.2 `fed.rss` — Federal Reserve press releases

**Endpoint** `GET https://www.federalreserve.gov/feeds/press_all.xml`.
**Fixture** `fed-press-rss.xml` (FIXTURES.md §fed-press-rss.xml), 20 items.

**Parse rules** — RSS 2.0, no namespaces, and three differences from §11.1 that earn it a separate adapter:

1. **The file starts with a UTF-8 BOM before `<?xml`.** The reader strips a leading `EF BB BF` before
   parsing; a BOM left in place makes most XML parsers reject the declaration.
2. `<guid>` is the **article URL** with no `isPermaLink` attribute
   (`https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260911a.htm`) — it is still the dedupe
   key, and it is stable.
3. `<pubDate>` is CDATA **with trailing whitespace** (`"Fri, 11 Sep 2026 14:00:00 GMT"    `) — trimmed
   before parsing.

| Payload | Becomes |
| --- | --- |
| `item/title` | `news_items.headline` (plain text, not CDATA here) |
| `item/link`, `item/guid` (CDATA) | `news_items.url`, `news_items.provider_guid` |
| `item/description` (CDATA) | `news_items.summary` — equals the title on every recorded row; stored anyway, so a future divergence is visible |
| `item/category` `"Banking and Consumer Regulatory Policy"` | `news_items.category` |
| `item/pubDate` | `news_items.published_at` |
| — | `news_items.source_id 'fed.rss'`, `feed 'press_all'`, `kind 'fed_release'`, `machine_generated false` |

**Entity links** — topic `FED` always (`method 'feed_topic'`, 1.0); topic `RATES` additionally when
`category` contains `Monetary Policy`; instrument/issuer links only through the ordinary exact-match rules
of §11.3 — which do fire, correctly, on enforcement actions that name a bank holding company by its
registered name.

**Writes**: `news_items`, `news_entity_links`; `fomc_meetings.decision_bp` when a `Monetary Policy`
release names a new target range (parsed from the headline, and left NULL when the pattern does not match
rather than guessed).

**Cadence** — `newsRss.ts`, 60 s, `cacheTtlMs 0` with `If-Modified-Since`.

**Staleness tier** — none; the Fed can legitimately publish nothing for days.

**Licence row** — `source_id 'fed.rss'`, `source_name 'Federal Reserve press releases'`,
`publisher 'Board of Governors of the Federal Reserve System'`,
`terms_url 'https://www.federalreserve.gov/data.htm'`, `licence_kind 'public_domain'`,
`display/non_display/derived/redistribution` all `true`, `export_allowed/api_allowed` `true`/`true`,
`max_tier 'eod'`, `intrinsic_delay_min 0`, `retention_days NULL`,
`attribution 'Fed communications: Federal Reserve Board.'`, `rate_limit '1/s (self-imposed)'`,
`requires_user_agent false`, `api_key_env NULL`.
The contrast with §11.1 is the point: the same screen shows a Bloomberg headline that cannot be exported
next to a Fed headline that can, and the entitlement evaluator gets both answers from this table.

### 11.3 Entity resolution — `news/entityLink.ts` (NEWS-02, precision over recall)

The requirement is explicit that precision beats recall, and `news_entity_links` encodes the floor in the
schema: `confidence` is CHECK-constrained to 0–1 and **links below 0.90 are never written**
(DATA_MODEL L1560). Everything below is built to make that floor meaningful rather than decorative.

#### 11.3.1 The dictionary

Built once per `newsRss.ts` run by `refdata/newsDict.ts` from the current security master (a snapshot, so
every story in one run sees the same dictionary and the run is reproducible):

| Map | Source | Exclusions |
| --- | --- | --- |
| `ciks: cik → issuerId` | `identifiers` scheme `CIK` | none |
| `tickers: TICKER → {instrumentId, issuerId}` | `instruments_now` where `asset_class ∈ {equity, etf}` and `status = 'active'`, upper-cased | a ticker mapping to **more than one** live instrument is **removed entirely** — an ambiguous ticker links to nothing rather than to a coin flip |
| `names: normName → issuerId` | `issuers_now.name` | a normalised name under 5 characters is dropped; a name mapping to >1 issuer is dropped |
| `aliases: normAlias → issuerId` | `issuer_aliases` (kinds `former_name`, `short_name`, `brand`, `curated`) and `issuers.former_names` | as for names; an alias mapping to >1 issuer is dropped |
| `topicKeywords: keyword → topicId` | `topics.keywords` | topic links only, never instrument links |
| `ambiguousWords` | a 400-entry list of English words and financial abbreviations that are also issuer names or tickers (`GAP`, `KEY`, `ALLY`, `LOW`, `ON`, `ALL`, `IT`, `CAT`, `SO`) | drives the ×0.90 modifier below |

Name normalisation (`core/text/normName.ts`, pure and shared with the resolver): NFKC, upper-case, strip
accents, strip punctuation, drop trailing legal forms (`INC`, `INCORPORATED`, `CORP`, `CORPORATION`, `CO`,
`COMPANY`, `PLC`, `NV`, `SA`, `AG`, `LTD`, `LIMITED`, `LLC`, `LP`, `HOLDINGS`, `GROUP`, `THE`), collapse
whitespace. `"Apple Inc."` and `"APPLE INC"` both normalise to `APPLE`.

#### 11.3.2 The matchers

Run over `headline + ' ' + summary` only — the body is never stored, so there is nothing else to match on.

| # | `method` | Trigger | Base confidence |
| --- | --- | --- | --- |
| 1 | `cik` | a 10-digit CIK in the SEC atom entry title (§7.5) | 1.00 |
| 2 | `ticker_exact` | a **marked** ticker: `/\$([A-Z]{1,5})\b/`, `/\(([A-Z]{1,5})(?:\s+(US\|UN\|UW\|UQ\|LN\|GR))?\)/`, or `/\b([A-Z]{1,5}):(US\|NYSE\|NASDAQ)\b/` | 1.00 |
| 3 | `name_exact` | a whole-token run of the normalised text equals a `names` key (longest match first) | 0.95 |
| 4 | `name_alias` | the same against `aliases` | 0.90 |
| 5 | `feed_topic` | the feed → `topics.code` map (`markets→MARKETS`, `economics→ECO`, `politics→POLITICS`, `technology→TECH`, `wealth→WEALTH`, `industries→INDUSTRIES`, `8-K→FILINGS`, `press_all→FED`) | 1.00 (topic only) |
| 6 | `keyword` | a `topics.keywords` hit | 0.90 (topic only) |
| 7 | `manual` | a data-ops correction (REF-10) | 1.00 |

#### 11.3.3 Scoring and the attach threshold

`score = base × Π modifiers`, evaluated in a fixed order, capped at 1.0:

| Modifier | When |
| --- | --- |
| × 1.00 | the match occurs in the **headline** |
| × 0.97 | the match occurs only in the summary — a story is about what its headline names |
| × 0.95 | the matched surface form is a **single token** (one word), which is where false positives live |
| × 0.90 | the matched form is in `ambiguousWords` **and** no second signal corroborates it (a different `method` hitting the same issuer, or a marked ticker for that issuer within 40 characters) |
| × 0.00 | the match falls inside a URL, inside an attribution to another publication, or inside a quoted string that is itself a headline |

**The threshold is 0.90** — the schema floor. The arithmetic is deliberately tight:

| Case | Score | Written? |
| --- | --- | --- |
| `$AAPL` in the headline | 1.00 | yes, `ticker_exact` |
| `(AAPL)` in the summary | 1.00 × 0.97 = 0.970 | yes |
| `Apple Inc` (exact name, headline, two tokens) | 0.95 | yes, `name_exact` |
| `Apple` (exact name, summary, single token, not ambiguous) | 0.95 × 0.97 × 0.95 = 0.875 | **no** |
| alias `Facebook` in the headline | 0.90 | yes, `name_alias` |
| alias in the summary | 0.90 × 0.97 = 0.873 | **no** |
| `GAP` (ambiguous, headline, single token, uncorroborated) | 0.95 × 0.95 × 0.90 = 0.812 | **no** |
| `GAP` in the headline plus `$GPS` in the summary | ticker match at 0.97 carries it | yes, via `ticker_exact` |

#### 11.3.4 Why a bare ticker string is not enough

`[A-Z]{1,5}` matches `US`, `AI`, `CPI`, `GDP`, `EU`, `FED`, `OPEC`, `ETF` — and `US`, `AI`, `ALL`, `IT`,
`ON` and `KEY` are live US tickers. A bare-token rule would attach *“US GDP Revised Up as Consumer Spending
Holds”* to three unrelated small caps, and every such link is visible on that issuer's CN screen, on the
`n:inst:` subject and in an alert. One wrong link on a user's own holding costs more trust than a hundred
missed links on stories they can still find through search. So the ticker matcher requires an explicit
marker (`$`, parentheses, or an exchange qualifier) and prose mentions are reached only through the full
name path.

Two more rules keep the link set honest:

- **Issuer → instrument fan-out is capped at one.** A name or CIK match resolves an *issuer*; the
  instrument link is written only for the issuer's primary composite (`instruments.primary_listing_id`
  set, `listings.is_primary`), never for all 275 venue FIGIs and never for every share class unless the
  headline names the class.
- **Story-level cap of 8 instrument links.** Beyond that, only issuer and topic links are kept, and a
  story that would exceed the cap by more than 4 opens `data_exceptions kind 'manual_review'` — a
  "biggest movers" list is a curation problem, not a linking problem.

#### 11.3.5 Measurement

`observability/dq.ts` samples 50 links per day into `data_exceptions(kind 'manual_review')` for spot
review; the target is **≥ 98 % precision**, and precision is the only release gate. Recall is reported
(share of stories with at least one instrument link) but never gated, because the requirement says which
way to err. A `manual` link or un-link by data ops is written with `method 'manual'`, confidence 1.0, and
is never overwritten by the automatic matcher.

---

## 12. `finra.shortInterest` — consolidated short interest

**Endpoint**
`GET https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest?limit=1000&offset={n}`.
**Headers** `Accept: text/csv` — the recorded capture is CSV, and asking for JSON changes the shape, so the
adapter pins the representation it parses. **Fixture** `finra-trace` (FIXTURES.md §finra-trace).

**Parse rules** (`providers/finra/parse.ts`, using the shared RFC 4180 CSV reader):

| CSV column | Column in `short_interest` | Rule |
| --- | --- | --- |
| `symbolCode` `A` | resolves `instrument_id` | via `identifiers(scheme 'TICKER_EXCH', value = symbolCode, qualifier 'US')`, cross-checked against `marketClassCode` |
| `issueName` `Agilent Technologies Inc.` | resolution fallback / cross-check against `issuers.name` | a name disagreement raises `reconcile_mismatch` |
| `marketClassCode` `NYSE` | cross-check against `listings.mic` | |
| `settlementDate` `2020-04-15` | `settlement_date` (PK with instrument) | the **settlement** date, not the publication date |
| `currentShortPositionQuantity` `4851353` | `short_qty` | |
| `previousShortPositionQuantity` `4767556` | `prev_short_qty` | |
| `averageDailyVolumeQuantity` `2012318` | `avg_daily_volume` | |
| `daysToCoverQuantity` `2.41` | `days_to_cover` | stored as published; recomputed as `short_qty / avg_daily_volume` and compared — divergence > 1 % is `reconcile_mismatch` |
| `changePercent` `1.76` | `change_pct` | |
| `changePreviousNumber` `83797` | dropped (no column) | but asserted equal to `current − previous`; a mismatch is `reconcile_mismatch` |
| `revisionFlag` | `revision` | `'Y'`/`'y'`/`'1'` → `true`, empty → `false` |
| `accountingYearMonthNumber`, `issuerServicesGroupExchangeCode`, `stockSplitFlag` | dropped | no columns; `stockSplitFlag` is surfaced in `dq_events.details` when set, because a split makes the change figures incomparable |

**Writes**: `short_interest`, PK `(instrument_id, settlement_date)` — a revision overwrites the row for
that settlement date, which is the intended semantics (FINRA republishes corrected figures under the same
date). Unresolved symbols get a `data_exceptions` row of kind `'unresolved_identifier'` and no row.

**Cadence** — `ingest/jobs/shortInterest.ts`, twice monthly (ARCHITECTURE §7.1); the schedule expression is
`0 20 10,26 * *` America/New_York, chosen to land after each of FINRA's two monthly publications (the
15th-of-month and end-of-month settlement dates are published roughly eight business days later). The job
short-circuits with `status 'skipped'` when the newest `settlementDate` in the response is not newer than
the stored maximum, so an early or late publication costs one request. Paging: `limit=1000` with
`offset` walked until a short page, capped at 20 pages.

**Staleness tier** — no `md_lines` row. The DES/QM short-interest block shows `settlement_date` and its
age; short interest is structurally two weeks old and the screen says so rather than going `stale`.

**Licence row**

| column | value |
| --- | --- |
| `source_id` / `source_name` | `finra.shortInterest` / `FINRA consolidated short interest` |
| `publisher` | `FINRA` |
| `terms_url` | `https://www.finra.org/finra-data/browse-catalog/short-interest` |
| `licence_kind` | `vendor_terms` |
| `display` / `non_display` / `derived` / `redistribution` | `true` / `false` / `true` / `false` |
| `export_allowed` / `api_allowed` | `true` / `false` |
| `max_tier` / `intrinsic_delay_min` | `eod` / `0` |
| `retention_days` | `NULL` |
| `attribution` | `Short interest: FINRA.` |
| `rate_limit` / `requires_user_agent` / `api_key_env` | `1/s (self-imposed)` / `false` / `FINRA_API_KEY` (unused; the keyless tier is sufficient) |
| `notes` | `Semi-monthly settlement dates published ~8 business days in arrears; the age is always displayed with the value.` |

**Failures and data quality** — fewer than 5,000 rows across the whole walk → `poll_anomaly`, nothing
written. `days_to_cover` above 100 → `out_of_range`, the field dropped and the quantities kept.
`short_qty` exceeding `EQY_SH_OUT` (from `dei.EntityCommonStockSharesOutstanding`, §7.3) →
`dq_events kind 'cross_source_divergence'`, `warn`: it is occasionally real (naked-short reporting lags)
and always worth a look.

---

## 13. The ingest job table

**Addition required.** CONTRACTS.md defines **no `ingest_jobs` table**. The job table is code — the
`IngestJob[]` exported from `ingest/jobs/index.ts` (GENERATED, ARCHITECTURE §3.3) whose element type is
`IngestJob { id, schedule, provider, priority, timeoutMs, run }` (ARCHITECTURE L974). The only persisted
artefact is `ingest_runs(run_id, job_id, source_id, started_at, finished_at, status, fetched, inserted,
updated, skipped, errors, trace_id)`, one row per execution. The table below is therefore the normative
content of `ingest/jobs/index.ts`, with `job_id` = `IngestJob.id` = the module basename.

**Naming convention fixed here:** `IngestJob.id` is the file basename without extension (`cboeQuotes`,
`yahooDaily`, `partitionMaintenance`), and it is what lands in `ingest_runs.job_id`. ARCHITECTURE L975's
example `'cboe.quotes.poll'` and DATA_MODEL L2104's mixed examples (`'cboe.quotes.poll'`, `'yahooDaily'`,
`'partitionMaintenance'`) are inconsistent with each other; the basename form is adopted because
`jobs/index.ts` is generated from the directory listing and the id can then be checked mechanically.

`schedule` is the literal `IngestJob.schedule` value: a cron expression in `America/New_York`, or
`{everyMs, jitterMs?, marketHoursOnly?, offHoursEveryMs?}`. `priority`: 1 = hot-set real-time,
2 = daily, 3 = weekly/reference.

| `id` | `provider` | `schedule` | Target set | `priority` | `timeoutMs` |
| --- | --- | --- | --- | --- | --- |
| `symbologyRefresh` | `openfigi.mapping`, `sec.tickers` | `'0 6 * * 1-5'` + on demand | new/unresolved tickers; full universe at seed (§6.1 tranches) | 3 | 600000 |
| `universeSymbolBook` | `cboe.symbolBook` | `'30 6 * * *'` | the whole 35,618-entry book | 3 | 60000 |
| `cboeQuotes` | `cboe.quotes` | `{everyMs: 10000, jitterMs: 1000, marketHoursOnly: true, offHoursEveryMs: 300000}` | hot set: subscribers ∪ connected watchlists ∪ always-on seed | 1 | 10000 |
| `cboeEuIndices` | `cboe.euIndices` | `{everyMs: 60000, marketHoursOnly: true, offHoursEveryMs: 900000}` | WEI European indices (§5.4, addition) | 1 | 10000 |
| `cboeOptions` | `cboe.options` | `{everyMs: 60000}`; daily otherwise | underlyings with an `oc:` or option `q:` subscriber; all option underlyings once daily | 1 | 30000 |
| `yahooIntraday` | `yahoo.chart` | `{everyMs: 60000, offHoursEveryMs: 300000}` | `b1m:` subscribers, then the rest of the hot set at 5 min | 1 | 15000 |
| `yahooDaily` | `yahoo.chart` | `'30 17 * * 1-5'` | every instrument with a `yahoo.chart` md line; `range=5y` windows at seed | 2 | 900000 |
| `fxIntraday` | `yahoo.chart` | `{everyMs: 60000}` | the G10 pairs in the always-on set | 1 | 15000 |
| `fxEod` | `frankfurter` | `'15 16 * * 1-5'` (Europe/Berlin) | all 30 published currencies | 2 | 20000 |
| `crypto` | `coingecko.simple` | `{everyMs: 60000}` | the fixed crypto id list, one request | 1 | 10000 |
| `secSubmissions` | `sec.submissions`, `sec.atom` | `{everyMs: 60000}` for the atom feed; `'0 * * * *'` for the per-CIK sweep | 8-K atom: all filers. Sweep: index members hourly, rest of the universe daily | 1 | 60000 |
| `secCompanyFacts` | `sec.companyfacts` | `'0 3 * * *'`, staggered ≤ 10 req/s | index members daily; universe weekly; any CIK with a new 10-K/10-Q immediately | 2 | 900000 |
| `secFrames` | `sec.frames` | `'0 3 * * 0'` | ~20 EQS concepts × last 8 frames | 3 | 600000 |
| `secNport` | `sec.submissions`, `sec.archives` | `'0 4 1 * *'` + on a new `NPORT-P` | SPY (CIK 0000884394); any other index proxy fund with `indices.proxy_fund_instrument_id` | 3 | 180000 |
| `ssgaHoldings` | `ssga.holdings` | `'0 19 * * 1-5'` | SPY daily holdings file | 2 | 60000 |
| `treasuryCurves` | `treasury.yieldcurve`, `treasury.bills` | `'0 18 * * 1-5'` | the current month's XML for both datasets | 2 | 120000 |
| `fedRates` | `nyfed.rates`, `fed.h15` | `'30 8 * * 1-5'` | all six NY Fed types + 11 H.15 CMT series | 2 | 60000 |
| `fredSeries` | `fred.csv` | `'30 16 * * 1-5'` (daily series); `'0 9 * * *'` (monthly, gated on `econ_release_events`) | the seeded FRED series list, 1 req/s | 2 | 300000 |
| `blsSeries` | `bls.timeseries` | `'35 8 * * 1-5'` on release days, else `'0 9 * * *'` | **one POST** carrying every headline series id (§10.5) | 2 | 30000 |
| `worldMacro` | `worldbank`, `imf.datamapper` | `'0 4 * * 0'` | the seeded indicator × country list | 3 | 600000 |
| `econCalendar` | `fred.calendar`, `bls.schedule`, `fed.fomc` | `'0 5 * * *'` | current + next month | 3 | 120000 |
| `newsRss` | `bbg.rss`, `fed.rss` | `{everyMs: 60000}` | six Bloomberg feeds + the Fed press feed, round-robin | 1 | 20000 |
| `shortInterest` | `finra.shortInterest` | `'0 20 10,26 * *'` | the full consolidated file, paged | 3 | 300000 |
| `partitionMaintenance` | — | `'0 1 * * *'` | next month's partitions for `bars_daily`, `bars_intraday`, `quote_ticks`, `option_quotes`, `access_log`, `usage_events`; drops beyond `retention_days` (STOR-07) | 3 | 300000 |
| `retentionPurge` | — | `'30 1 * * *'` | non-partitioned tables with a `retention_days` ceiling | 3 | 300000 |
| `dqMonitors` | — | `{everyMs: 60000}` | every check in §14 | 2 | 30000 |
| `reconcile` | — | `'45 18 * * 1-5'` | Cboe vs Yahoo closes on the hot set; Treasury vs H.15 vs `^TNX`; N-PORT vs SSGA; BLS vs FRED | 2 | 300000 |
| `usageDeclarations` | — | `'0 2 1 * *'` | `access_log` → `usage_declarations` (ENTL-06, DATA-02) | 3 | 600000 |

Scheduler rules that apply to every row (ARCHITECTURE §7.1): one running instance per job; a 1-second tick
on the injected `Clock`; leader election through `pg_try_advisory_lock(hashtext('ingest-leader'))`; failure
backoff `2^n × 5 s` capped at 10 minutes; the per-provider breaker of §2.5; and the 70 % bucket share that
keeps interactive requests alive. Every job is idempotent — time-series upserts on natural keys, reference
writes through `upsertVersion` — which is what makes "re-run it" a safe answer to any failure.

---

## 14. Data-quality checks, by source (OPS-03, QA-03)

`ingest/jobs/dqMonitors.ts` runs the periodic checks; `ingest/jobs/reconcile.ts` runs the cross-source
ones after the US close; adapters raise the rest inline. Everything lands in `dq_events(ts, kind,
severity, instrument_id, md_line_id, source_id, subject, details, resolved_at)` with the `kind` enum from
DATA_MODEL L2121; ops-actionable items also open a `data_exceptions` row with an SLA.

### 14.1 Stale-tick detection (`kind 'stale_tick'`)

| Source | Rule | Severity |
| --- | --- | --- |
| `cboe.quotes`, `cboe.options`, `cboe.euIndices` | no capture for `3 × expected_interval_ms` during an open session (the same threshold `valueState` uses, so screen and alert always agree); or `last_trade_time` more than 30 min behind the payload `timestamp` in session | `warn` |
| `yahoo.chart` | no new `bar_ts` for 3 polls while the session is open | `warn` |
| `coingecko.simple` | no price change **and** no capture for 3 minutes | `info` |
| `nyfed.rates`, `fed.h15`, `treasury.*` | no publication by 12:00 ET on a business day | `error` |
| `bbg.rss` | no new `provider_guid` on a feed for 6 h during US market hours | `warn` |
| any | `dq` carries `'PROVIDER_DOWN'` from an open breaker (§2.5) | `error` |

### 14.2 Cross-source divergence (`kind 'cross_source_divergence'`)

| Pair | Tolerance | Job |
| --- | --- | --- |
| **Cboe close vs Yahoo close**, per hot instrument, same `session_date` | > 0.5 % | `reconcile.ts`, 18:45 ET |
| Cboe `iv30` vs our own `vol_surfaces.atm_iv` front expiry | > 5 vol points | `reconcile.ts` |
| Treasury `BC_10YEAR` vs H.15 `RIFLGFCY10_N.B` vs Yahoo `^TNX ÷ 10`, same date | > 5 bp on any pair | `reconcile.ts` |
| `treasury.bills` investment yield vs FRED `DTB3` | > 5 bp | `reconcile.ts` |
| **N-PORT vs SPDR** membership and weights at the N-PORT as-of date | 5 bp per name; 50 bp aggregate (§8.2) | `ssgaHoldings.ts`, `reconcile.ts` |
| frankfurter fx vs Yahoo `=X` close, same date | > 0.5 % | `fxEod.ts` |
| BLS `CUUR0000SA0` vs FRED `CPIAUCNS`, same month | > 0.01 index points | `blsSeries.ts` |
| World Bank US GDP vs FRED `GDP`, same year | > 1 % (`info`) | `worldMacro.ts` |
| FINRA `short_qty` vs `dei.EntityCommonStockSharesOutstanding` | short > shares outstanding | `shortInterest.ts` |

### 14.3 Missing-close alarms (`kind 'missing_close'`)

| Source | Rule |
| --- | --- |
| `cboe.quotes` | no `PX_OFFICIAL_CLOSE` for an instrument with an open session that day, by 18:30 ET |
| `yahoo.chart` | no `bars_daily` row for a hot instrument by 18:30 ET |
| `frankfurter` | no new `rate_date` after 16:30 CET on a TARGET2 business day |
| `treasury.yieldcurve` / `treasury.bills` | no curve point for a SIFMA business day by 20:00 ET; or `BOND_MKT_UNAVAIL_REASON` non-empty |
| `nyfed.rates` | no fixing for a business day by 12:00 ET |
| `fred.csv` | a daily series with no new observation for 3 business days |
| `ssga.holdings` | no file for 2 consecutive business days |

### 14.4 Field-population rates (`kind 'field_population'`)

Computed daily per `(source_id, field_id)` as populated ÷ eligible captures, over the open session:

| Source | Field | Floor |
| --- | --- | --- |
| `cboe.quotes` | `PX_BID`/`PX_ASK` on lines that normally publish a book | 95 % |
| `cboe.quotes` | `PX_VOLUME` on equity lines | 99 % |
| `cboe.options` | `OPT_IV`, `OPT_DELTA` on contracts with a two-sided market | 90 % |
| `yahoo.chart` | non-null OHLCV bars per session | 97 % |
| `sec.companyfacts` | index members with `revenue` and `net_inc` for the latest complete quarter | 90 % |
| `sec.archives` / `ssga.holdings` | holdings resolved to an `instrument_id` | 98 % |
| `nyfed.rates` | percentiles present on SOFR/EFFR/OBFR | 99 % |
| `news` | stories with ≥ 1 entity link of any kind | 60 % (reported, not gated — §11.3.5) |

### 14.5 The remaining kinds

| Kind | Raised by |
| --- | --- |
| `poll_anomaly` | payload-size and row-count guards: symbol book < 30,000; `company_tickers` < 8,000; N-PORT/SPDR holdings outside 495–515; option chain shrinking > 20 %; SEC atom poll with zero overlap; `Σ weight` outside 99.0–100.5 % |
| `reconcile_mismatch` | provider-computed values we recompute: Cboe `price_change`/`tick`; FINRA `daysToCover`/`changePreviousNumber`; Treasury `CS_*_AVG` vs `ROUND_B1_*`; `BC_30YEARDISPLAY` vs `BC_30YEAR`; XBRL balance-sheet identities |
| `parse_error` | any `NormaliseProblem` of kind `parse_error`, plus range violations that drop a value |
| `provider_circuit_open` | §2.5, once per opening, with `{consecutiveFailures, lastStatus, lastUrl, openedAt}` |
| `default_partition_nonempty`, `ref_orphans` | `partitionMaintenance.ts` and a nightly referential sweep (`index_members` → missing instrument, `filings` → missing issuer) |
| `ws_backpressure`, `plant_degraded`, `replay_diff` | plant and harness concerns, out of scope for this document |

Every `dq_events` row is visible on the ops screen and in `GET /api/v1/status`; `severity 'error'` also
opens or updates a `status_incidents` row so `sys:status` carries it to every connected terminal (OPS-04).

---

## 15. Licence registry summary — every source in one table

Seeded by `providers/licences.ts` (`provenance_id NULL` on bootstrap rows, the only rows allowed to have
it). `source_id` is trigger-checked on every write through `assert_source_known`, so a source missing from
this table cannot store a single value (§1.3). `d/n/dv/r` = display / non-display / derived /
redistribution; `x/a` = export_allowed / api_allowed.

| `source_id` | `publisher` | `licence_kind` | d/n/dv/r | x/a | `max_tier` | `intrinsic_delay_min` | `retention_days` | `rate_limit` | UA? | `api_key_env` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cboe.quotes` | Cboe Global Markets | `exchange_delayed` | t/f/t/f | t/t | `delayed` | 15 | **30** | 4/s | no | — |
| `cboe.options` | Cboe Global Markets | `exchange_delayed` | t/f/t/f | t/t | `delayed` | 15 | **10** | 4/s | no | — |
| `cboe.symbolBook` | Cboe Global Markets | `exchange_delayed` | t/f/t/f | t/t | `eod` | 0 | — | 4/s | no | — |
| `cboe.euIndices` | Cboe Europe | `exchange_delayed` | t/f/t/f | t/t | `delayed` | 15 | — | 4/s | no | — |
| `yahoo.chart` | Yahoo | `unofficial` | t/f/t/f | t/**f** | `delayed` | 15 | **400** | 2/s | **yes** | — |
| `yahoo.search` | Yahoo | `unofficial` | t/f/f/f | f/f | `eod` | 0 | — | 2/s | **yes** | — |
| `openfigi.mapping` | Bloomberg Finance L.P. | `open_data` | t/t/t/**t** | t/t | `eod` | 0 | — | 25/min, 10 jobs/req | no | `OPENFIGI_API_KEY` |
| `sec.tickers` | SEC | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 10/s | **yes** | — |
| `sec.submissions` | SEC | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 10/s | **yes** | — |
| `sec.companyfacts` | SEC | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 10/s | **yes** | — |
| `sec.frames` | SEC | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 10/s | **yes** | — |
| `sec.atom` | SEC | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 10/s | **yes** | — |
| `sec.archives` | SEC | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 10/s | **yes** | — |
| `ssga.holdings` | State Street Global Advisors | `vendor_terms` | t/f/t/f | t/f | `eod` | 0 | — | 1/s | **yes** | — |
| `treasury.yieldcurve` | U.S. Treasury | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 1/min | no | — |
| `treasury.bills` | U.S. Treasury | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 1/min | no | — |
| `fred.csv` | FRB St. Louis | `open_data` | t/t/t/f | t/t | `eod` | 0 | — | 1/s | no | `FRED_API_KEY` (unused) |
| `fred.calendar` | FRB St. Louis | `open_data` | t/f/t/f | t/t | `eod` | 0 | — | 1/s | no | — |
| `fed.h15` | Federal Reserve Board | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 1/s | no | — |
| `fed.rss` | Federal Reserve Board | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 1/s | no | — |
| `fed.fomc` | Federal Reserve Board | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 1/s | no | — |
| `nyfed.rates` | FRB New York | `open_data` | t/t/t/f | t/t | **`realtime`** | 0 | — | 1/s | no | — |
| `bls.timeseries` | U.S. BLS | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | **25/day** | no | `BLS_API_KEY` (unused) |
| `bls.schedule` | U.S. BLS | `public_domain` | t/t/t/t | t/t | `eod` | 0 | — | 1/s | no | — |
| `worldbank` | World Bank | `open_data` | t/t/t/t | t/t | `eod` | 0 | — | 1/s | no | — |
| `imf.datamapper` | IMF | `vendor_terms` | t/f/t/f | t/f | `eod` | 0 | — | 1/s | no | — |
| `frankfurter` | ECB (via frankfurter.dev) | `open_data` | t/t/t/t | t/t | `eod` | 0 | — | 1/s | no | — |
| `finra.shortInterest` | FINRA | `vendor_terms` | t/f/t/f | t/f | `eod` | 0 | — | 1/s | no | `FINRA_API_KEY` (unused) |
| `bbg.rss` | Bloomberg L.P. | `vendor_terms` | t/f/f/f | **f/f** | `eod` | 0 | — | 1/s | **yes** | — |
| `coingecko.simple` | CoinGecko | `unofficial` | t/f/t/f | t/f | `delayed` | 0 | — | 1/s | no | — |
| `wiki.sp500` | Wikipedia contributors | `cc_by_sa` | t/f/t/t | t/t | `eod` | 0 | — | on demand | no | — |
| `internal.derived` | This platform | `internal` | t/t/t/t | t/t | `realtime` | 0 | — | — | no | — |
| `internal.user` | This platform | `internal` | t/t/t/t | t/t | `realtime` | 0 | — | — | no | — |

**`retention_days` is the only input to partition drops and `retentionPurge` (STOR-07), so exactly three
rows may carry a number**, one per partitioned market-data table, and they are the numbers DATA_MODEL §2
L337 and §7.1 rule 5 state: `cboe.quotes` **30** (governs `quote_ticks`), `cboe.options` **10** (governs
`option_quotes`), `yahoo.chart` **400** (governs `bars_intraday`). Every other row is NULL = unlimited —
including `cboe.euIndices` and `coingecko.simple`, whose observations land in tables governed by the
source above them; a number on those rows would be inert and would contradict the table that is actually
dropped. `packages/server/src/providers/licences.ts` seeds exactly these values, and WP-05's
`ingest/partitions.test.ts` must read the retention it asserts **from `licence_registry`**, never from a
literal in the test, so there is one source of truth.

Four rows carry the whole entitlement story: `yahoo.chart` is the only price source that cannot leave
through the public API; `bbg.rss` is display-only and is stripped from every CSV; `nyfed.rates` is the only
source whose `max_tier` is `realtime`, because published fixings are not delayed quotes; and
`openfigi.mapping`, `frankfurter`, `worldbank` and every SEC row are the sources whose
`redistribution true` lets the terminal answer an API call with a real value rather than a downgrade.
`internal.derived` and `internal.user` have no HTTP adapter and no `ProviderId` — they exist so that
calendars, curves, `fin_statements`, the simulated feed (§4.3) and data-ops edits can all carry a
`provenance` row and satisfy the `assert_source_known` trigger.

---

## 16. Additions required

Everything below is needed by this document and is **not** defined in CONTRACTS.md. Each is flagged inline
above as well.

1. **No `ingest_jobs` table exists** (§13). The job table is `IngestJob[]` in `ingest/jobs/index.ts`; only
   `ingest_runs` is persisted. The task's "ingest job table" is delivered as the normative content of that
   module.
2. **`IngestJob.id` convention** (§13): the module basename. ARCHITECTURE L975 (`'cboe.quotes.poll'`) and
   DATA_MODEL L2104 (mixed) disagree with each other; the basename form is adopted and both documents need
   the correction.
3. **`xbrl_concept_map` priority ordering for `REVENUE`** (§7.3.1). DATA_MODEL L1305's inline example is
   `Revenues=1, RevenueFromContract…=2, SalesRevenueNet=3`; this document orders
   `RevenueFromContractWithCustomerExcludingAssessedTax=1, Revenues=2, SalesRevenueNet=3`, because
   post-ASC-606 filers tag the former and `Revenues` survives mainly on pre-2018 filings. The seed data and
   DATA_MODEL's comment must be reconciled — the ordering is a data decision, not a schema change, and it
   is versioned by `mapping_version`, so both orderings can coexist as `std-map/2026.09` and a successor.
4. **`ingest/jobs/cboeEuIndices.ts`** (carried from part A §5.4) — ARCHITECTURE §7.1 has no row for it.
5. **Shared parser modules** not named in the ARCHITECTURE module map, which only lists
   `adapter.ts`/`parse.ts` per provider directory: `providers/xml.ts` (a streaming, namespace-aware reader
   used by SEC N-PORT, the Treasury OData feeds and both RSS adapters), `providers/html.ts` (a tolerant
   tag/text tokeniser for the FRED and BLS calendars and the FOMC page), `providers/csv.ts` (RFC 4180, used
   by FRED, H.15 and FINRA) and `providers/ssga/xlsx.ts` (the ~150-line ZIP + sheet reader of §8.1).
   All four are pure and are fuzz targets under QA-05.
6. **`refdata/newsDict.ts`** (§11.3.1) — the per-run matcher dictionary. ARCHITECTURE names
   `news/entityLink.ts` but no dictionary builder, and building it inside the linker would rebuild it per
   story.
7. **`core/text/normName.ts`** (§11.3.1) — the shared name normaliser, used by the matcher and by
   `refdata/resolve.ts`'s name fallback.
8. **`core/ids/cik.ts`** (§7) — `pad`/`unpad`, because `data.sec.gov` and `/Archives` disagree about CIK
   padding and the conversion must exist in exactly one place.
9. **Fixtures not recorded**: the IMF DataMapper *observations* endpoint (§10.8), the Bloomberg `wealth`
   feed (§11.1), and the FOMC calendar page (§10.9). Each needs a `scripts/fixtures-urls.ts` entry and a
   `npm run fixtures:record` pass before its job can be covered by QA-02; until then those paths run only
   in `live`/`record` mode.
10. **`scripts/fixtures-urls.ts` must record the post-redirect Bloomberg URLs** (`www.bloomberg.com/feeds/…`),
    not the `feeds.bloomberg.com` form, or every Bloomberg capture misses on key (§11.1).
11. **Not an addition — a digest defect to be aware of.** CONTRACTS renders several CHECK lists with their
    first literal elided (`econ_release_events.status` as `…,'released','revised','delayed','cancelled'`,
    `econ_observations.status` as `…,'preliminary','revised','missing'`). Both were verified against
    DATA_MODEL: the real lists are `('scheduled','released','revised','delayed','cancelled')` (L1440,
    DEFAULT `'scheduled'`) and `('final','preliminary','revised','missing')` (L1403, DEFAULT `'final'`),
    which is what §10.1, §10.2, §10.6, §10.7 and §10.8 write. Any other section of this design that reads
    a CHECK list out of CONTRACTS alone must do the same verification.

## 17. Open questions

1. **The `openfigi-map` capture's shape.** FIXTURES.md §openfigi-map digests the body as
   `[2 × {data: [1 × {...}]}]` — two jobs, one row each — while DATA_MODEL §3.1 L535 describes it as
   "275 venue rows for AAPL, all `compositeFIGI=BBG000B9XRY4`". Both cannot be true of the same file. The
   §6.1 parse rules are written to handle either (the venue-row branch is exercised only when
   `figi !== compositeFIGI`), but `scripts/fixtures-import.ts` and the golden normaliser output cannot be
   finalised until the recorded bytes are inspected. If the capture really carries one row per job, a
   second capture with `exchCode` omitted is needed to cover the `listings` path at all.
2. **The FINRA fixture is named `finra-trace`** but its columns are consolidated *short interest*, not
   TRACE. The file name is misleading and the `FIXTURE_URLS` entry must map it to the
   `consolidatedShortInterest` URL; whether a separate TRACE capture was intended and lost is unknown.
   No TRACE endpoint is used anywhere in v1 (corporate bonds are out of scope, BRIEF §1).
3. **FINRA's default representation.** The capture is CSV; the endpoint also serves JSON. §12 pins
   `Accept: text/csv`, but the two representations may paginate differently (`offset` vs a cursor), which
   cannot be settled from one 2-row capture.
4. **The SPDR `Identifier` column's scheme.** FIXTURES.md records the column name only. §8.1 assumes CUSIP
   for US names (which is what SSGA publishes for domestic equity funds) with SEDOL as a separate column;
   if the column actually carries a mixed scheme, the resolution order in §8.1 needs a per-row scheme
   sniff rather than a fixed order.
5. **`bls.timeseries` keyless series-per-query limit.** The documented keyless v2 tier allows 25 series
   per query and 25 queries per day, but the recorded fixture contains a single series, so the multi-series
   request in §10.5 is unverified against the live endpoint. If the keyless tier in fact caps at fewer
   series, `blsSeries.ts` must split into two or three queries a day — still comfortably inside the daily
   budget, but the fixture and the golden output would change.
6. **The Treasury month parameter and revisions.** The month-scoped query returns the month to date, but
   whether Treasury revises an earlier day's row in place (which would need a new `curve_points.vintage_at`)
   is not observable from a single capture. §9.1 writes a new vintage on any value change, which is correct
   either way, but the revision frequency — and therefore the cost of the daily diff — is unknown.
7. **`econ_releases.importance`.** The column exists; neither FRED nor BLS publishes an importance ranking.
   §10.2 and §10.6 leave it NULL, which makes ECO's "high importance only" filter inert. A curated seed
   list is the obvious fix, but curating it is a product decision, not a provider one.
