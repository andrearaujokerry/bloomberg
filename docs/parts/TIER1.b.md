### TOP — Top News

| Attribute | Value |
| --- | --- |
| Code / aliases | `TOP` / `TOPN` |
| Tier / category | 1 / news |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/TOP.ts` · `packages/server/src/functions/TOP/resolve.ts` · `packages/web/src/screens/TOP/Screen.tsx` · `fixtures/golden/functions/TOP.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (NEWS-01) (NEWS-02) (NEWS-03) (NEWS-07) (NEWS-08) (TERM-06) (TERM-08) (TERM-12) (DATA-09) (DATA-10) (ENTL-01) (ENTL-05) (STOR-04) (OPS-03) |

#### Params
```ts
export const TopParams = z.object({
  scope: z.enum(['auto', 'all', 'feed', 'topic', 'instrument']).default('auto'),
  id: z.string().max(64).optional(),                              // topic code ('FED'), feed name ('markets') or instrument id as a string
  limit: z.number().int().min(10).max(50).default(30),
  kinds: z.array(z.enum(['story', 'video', 'filing', 'press_release', 'fed_release'])).default(['story', 'video', 'filing', 'press_release', 'fed_release']),
});
```
#### Argument grammar
`positional [{ name:'id', type:'string', optional:true }]`, `keyed { SCOPE: { name:'scope', type:'enum', values:['auto','all','feed','topic','instrument'] }, N: { name:'limit', type:'int' }, KIND: { name:'kinds', type:'enum', values:['story','video','filing','press_release','fed_release'], repeat:true } }`, no `rest`.
Examples: `TOP` → `{ scope:'auto', limit:30, kinds:[all five] }` · `TOP FED` → `{ scope:'auto', id:'FED' }` (resolved to `topic`) · `TOP markets N=50 KIND=STORY` → `{ scope:'auto', id:'markets', limit:50, kinds:['story'] }` (resolved to `feed`).
`scope:'auto'` with no `id` resolves to `all`. A security loaded in the panel is **ignored** by TOP (`requiresSecurity:false`): issuer-linked news is `CN`, instrument-scoped ranking is `TOP SCOPE=INSTRUMENT id=<instrumentId>` (TERM-03 leaves the panel security untouched).

#### Payload
```ts
import type { NewsRow } from '../shared/news';                    // §0.2

export type TopPayload = {
  variant: 'default';
  resolved: { scope: 'all' | 'feed' | 'topic' | 'instrument'; id: string | null; label: string /* 'All news' | 'Markets' | 'Federal Reserve' | 'AAPL US Equity' */ };
  rows: Array<NewsRow & { rank: number; rankParts: { recency: number; feedWeight: number; linkConfidence: number; clickThrough: number } }>;   // rank desc, ties → publishedAt desc, then newsId desc
  liveSubject: string;                                            // 'n:all' | 'n:feed:markets' | 'n:topic:FED' | 'n:inst:42'
  feedHealth: Array<{ sourceId: 'bbg.rss' | 'sec.atom' | 'fed.rss'; feed: string; lastCapturedAt: string | null; expectedIntervalMs: number;
                      st: 'live' | 'stale' | 'blank'; provIdx: number }>;                                                    // TERM-12
  suppressed: { entitlement: number; kindFilter: number };        // rows dropped before `rows` was built, so the screen can say so (ENTL-05)
  asOf: string;                                                   // ISO, ctx.asOf.validAt
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `news_items` (`tsv` unused here; ordered by `published_at`), `news_entity_links`, `topics`, `instruments` (current, for `n:inst:` label and link display), `issuers` (current, link display), `provenance` (per `news_items.provenance_id`), `licence_registry` (`display`, `export_allowed`, `attribution`, `intrinsic_delay_min`), `usage_events` (7-day click-through aggregate, `kind='search.select'`, `details->>'newsId'`), `ingest_runs` (`feedHealth.lastCapturedAt` per `job_id`) |
| Data services (§1.4.2) | `data.news.top(scope, id, limit)` (→ `GET /news/top`, ranked by `packages/server/src/news/ranker.ts`), `data.news.topics()` (topic label), `data.reference.instrument(id)` (instrument-scope label only) |
| Read-through (`providers.ensure`) | `('bbg.rss', feed, { maxAgeMs: 60_000 })` for each of the six Bloomberg feeds when `feedHealth[i].st !== 'live'` and `usage !== 'export'`; `('fed.rss', 'press_all', { maxAgeMs: 300_000 })` when the `fed.rss` line is stale. **No read-through exists for `sec.atom`** (`ReadThroughKind` has no such member, FUNCTIONS.md §1.4.2): 8-K headlines arrive only from the `sec.8kAtom` scheduler job, and a stale `sec.atom` line is reported in `feedHealth` with `st:'stale'` and never refetched inline. |
| Engines (`core/analytics`) | None. |
| Subjects (live) | exactly one of `n:all`, `n:feed:<feed>`, `n:topic:<code>`, `n:inst:<instrumentId>` (API.md §6.1) |
| Field ids (`fieldIds(assetClass)`) | `default: []` — `n:` subjects are subscribed with `f: []` ("all fields of the subject", API.md §6.1); the subject's dictionary fields are `NEWS_ID HEADLINE PUBLISHED_AT SOURCE_ID LINK KIND IS_CORRECTION` (`fieldClass:'news'`, `assetClasses: []`). The entitlement pre-check set is therefore the **source** set `['bbg.rss','sec.atom','fed.rss']` against `field_licence` `field_class='news'`, not a field list. |

#### Resolver
1. Resolve scope. `scope:'auto'` → `id` absent: `{ scope:'all', id:null, label:'All news' }`; `id` present: uppercase match on `topics.code` → `topic` (label `topics.name`); else lowercase match on the distinct `news_items.feed` values → `feed` (label = feed title-cased); else `/^\d+$/` → `instrument` (label = `data.reference.instrument(Number(id)).display`); else `ctx.unavailable.add({ field:'scope', reason:'NOT_APPLICABLE', detail:`UNKNOWN_SCOPE: '${id}' is neither a topic code, a feed nor an instrument id` })` and fall back to `all` (NEWS-01: the screen always shows something).
2. `feedHealth`: one query over `ingest_runs` (`job_id IN ('bbg.rss.markets', …, 'fed.press.poll', 'sec.8kAtom')`, latest `finished_at` with `status='ok'`) joined to `licence_registry` for `expected` cadence; `st = 'live'` when `now − lastCapturedAt ≤ 3 × expectedIntervalMs`, `'stale'` beyond that (the `valueState` rule of ARCHITECTURE §4.2 applied to a feed), `'blank'` when the job never ran; `provIdx = ctx.prov.add({ sourceId, provenanceId, capturedAt, sourceTs:null, st, tier:'delayed' })`.
3. Read-through per the table above for any `bbg.rss` / `fed.rss` line that is not `live`. A `ProviderUnavailableError` is caught, not rethrown: the line keeps `st:'stale'` and `ctx.unavailable.add({ field:'feedHealth.<sourceId>', reason:'NO_SOURCE', detail:'PROVIDER_DOWN: serving stored headlines' })` (TERM-12 — never silently fresh).
4. `items = await data.news.top(resolved.scope, resolved.id ?? undefined, params.limit + 20)` — the ranker over-fetches so the `kinds` filter does not shorten the page.
5. Filter by `params.kinds`, counting drops into `suppressed.kindFilter`. Filter by licence: a row whose `source_id` has no `display` grant for `ctx.user.firmId` (evaluator rule 3, ARCHITECTURE §10) is dropped into `suppressed.entitlement` and its `FieldDecision` is recorded in `meta.entitlement` once per source with `reason:'NO_FIRM_ENTITLEMENT'` (ENTL-05). Access is logged per source, not per headline (one `access_log` row per distinct `source_id` with `field_class:'news'`, `purpose:'TOP'`).
6. Map to `NewsRow` (§0.2), truncate to `params.limit`, attach `rank`/`rankParts` from the ranker (`recency = exp(−ageMinutes / 180)`; `feedWeight` from `topics.kind` and source — `bbg.rss markets` 1.0, other bbg feeds 0.8, `fed.rss` 0.9, `sec.atom` 0.6; `linkConfidence = max(links[].confidence)` or 0.5 when unlinked; `clickThrough` = 7-day `usage_events` selects / impressions, `0` before any history with `ctx.unavailable.add({ field:'rows[].rankParts.clickThrough', reason:'NO_SOURCE', detail:'NO_CLICKTHROUGH_HISTORY: fewer than 7 days of usage events' })`). `machineGenerated` is `false` on every row (NEWS-08); the ingest never writes `true` in v1.
7. `provIdx` per row from `ctx.prov.add({ sourceId: row.sourceId, provenanceId: news_items.provenance_id, capturedAt, sourceTs: publishedAt, st:'closed', tier:'delayed' })` — a headline is an immutable stored record, not a live cell (§0.4 rule 3).
8. Return. Budget: 2 DB round-trips (ranker query + `feedHealth`) plus at most 1 provider call; first paint < 500 ms p95, 0 provider calls when the scheduler is healthy.

#### Live
`{ subjects: [payload.liveSubject], fields: [], essential: [payload.liveSubject] }` — `conflationMs` is omitted because `n:` is **not conflated** (API.md §6.1: one `delta` per headline, in `publishedAt` order). `packages/web/src/screens/TOP/Screen.tsx` prepends each `delta` as a new `list#rows` item with `rank = rows[0].rank + 1` (a live headline always sorts first, its rank is recomputed on the next `launchKind:'refresh'`), flashes it for 2 s (TERM-08), caps the list at `params.limit` and drops the tail. NEWS-03 budget: RSS receipt → screen < 1 s.

#### Screen
```
┌ TOP · Top News · All news                                   30 headlines · 18:41:28 · ● bbg.rss ● fed.rss ◐ sec.atom ┐
│ badges#health   [bbg.rss markets 18:40:06 live] [fed.rss 18:12:40 live] [sec.atom 18:21:20 STALE 20m]               │
│ list#rows  (newsList('rows', rows, { showFeed:true, showKind:true, showRank:true, dense:true }))                    │
│  15:04  MKT  ▶  AI Will Be Biggest 'Misallocation' of Capital, Says Noble          [CORRECTION]   0.9412            │
│  14:21  FIL  ▤  8-K · Aerkomm Inc · Item 5.02 Departure of Directors                AERK US       0.5108            │
│  13:55  FED  ◆  Federal Reserve Board announces …                                   FED           0.7730            │
│ text#suppressed  3 headlines hidden by KIND filter · 0 hidden by entitlement                                        │
│ footer sources: Bloomberg RSS (headlines and link only, no article body); SEC EDGAR 8-K current-filings Atom;        │
│                 Federal Reserve press releases — asOf 2026-09-15T18:41:28Z                                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `TOP · Top News · <resolved.label>`; subtitle `<rows.length> headlines · <asOf HH:mm:ss in the user's tz> · <feedHealth glyphs>`; `initialFocus:'rows'`. Columns of `list#rows`: published time (`fmt:'datetime'`, time-only for today, `dd/MM HH:mm` otherwise), a three-letter feed tag, a kind glyph (`▶` video, `▤` filing, `◆` press_release/fed_release, blank story), the headline (`fmt:'text'`, never truncated below 60 chars — the list wraps), the linked entities (`links[].display`, up to two, `+n` beyond), `[CORRECTION]` badge when `isCorrection`, and `rank` (`fmt:'pct'`-style 4 decimals, hidden when the panel is narrower than 100 cols). A row with `machineGenerated === true` would render in a separate muted block under a `Machine-generated` divider (NEWS-08); v1 never produces one and the screen asserts that in its test. Skeleton while `payload === undefined`: `badges#health` with three muted chips and ten muted list rows. `meta.unavailable` entries render as one muted line under the list; `meta.entitlement` denials render as the `text#suppressed` line with the source name and reason.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | list (`list#rows`) | `open-story` | `ctx.openUrl(row.url)` in a new tab (link-out only — no body is stored, DATA_MODEL §10) and emit `usage_events { kind:'search.select', code:'TOP', details:{ newsId, rank: row.rank } }` (the ranker's click-through input) |
| `Shift+Enter` | list | `open-story-next` | `ctx.navigateNext('N ' + row.newsId)` — the N reader in the next panel |
| `Ctrl+I` | list | reserved provenance | `ctx.provenance(row.provIdx)` — feed URL, `request_key`, captured-at, raw fixture (DATA-10) |
| `S` | always | `open-security` | `ctx.navigate(row.links.find(l => l.entityKind === 'instrument')?.display + ' DES')`; no instrument link → no-op with a `notice` |
| `N` | always | `open-n` | `ctx.navigate('N ' + JSON.stringify(row.headline.slice(0, 40)))` — the same headline as a search |
| `I` | always | `open-ni` | `ctx.navigate('NI ' + (row.links.find(l => l.entityKind === 'topic')?.display ?? resolved.id ?? ''))` |
| `C` | always | `cycle-scope` | `ctx.setParams({ scope: next of ['all','feed','topic'] })` (usage `fn.param`) |
| `K` | always | `cycle-kinds` | `ctx.setParams({ kinds })` cycling all → stories only → filings only |
| `+` / `-` | always | `more` / `fewer` | `ctx.setParams({ limit: clamp(limit ± 10, 10, 50) })` |
| `A` | list | `alert-on-scope` | `sdk.alerts.create({ condition: { kind:'news', query: { topic: resolved.scope === 'topic' ? resolved.id : undefined, feed: resolved.scope === 'feed' ? resolved.id : undefined } } })` (NEWS-07) |

#### CSV
`filename = 'TOP_' + (resolved.id ?? 'ALL') + '_' + asOfCompact + '.csv'` (`asOfCompact = asOf.replace(/[-:]/g,'')`). Columns = `newsCsvColumns` (§0.5) with one appended column `{ id:'rank', label:'Rank', type:'number', decimals:4 }`; rows = `rows.map(r => [...newsCsvRow(r), r.rank])`. Single-block, so no `section` column. Rows whose `source_id` has `licence_registry.export_allowed = false` are omitted and counted in a `# suppressed: <n> rows (NOT_LICENSED_EXPORT: <sourceId>)` header comment above the `# asOf` line (ENTL-01, API.md §9); `attribution` carries one line per surviving source from `licence_registry.attribution`. Example row: `2026-09-15T15:04:08Z,bbg.rss,markets,video,"AI Will Be Biggest 'Misallocation' of Capital, Says Noble",https://www.bloomberg.com/news/videos/2026-09-15/ai-will-be-biggest-reallocation-of-capital-says-noble-video,,true,1041,0.9412`.

#### Help
summary `Ranked headline feed by topic, feed or security, with live prepend`; description `TOP is the ranked front page of the normalised news stream: Bloomberg RSS headlines, SEC 8-K current filings and Federal Reserve press releases in one list, newest and most relevant first. Ranking combines recency, the weight of the feed, the confidence of the entity link and how often the desk opens that kind of headline. Only headlines, summaries and links are stored — article bodies stay with the publisher, so Enter opens the story on the publisher's site. Headlines arrive live: a new story is prepended and flashed within a second of receipt, never overwriting an earlier one. The health chips show when each feed was last captured; a feed that stops publishing goes stale rather than silently empty. Nothing on this screen is machine-generated.`; params `scope` ("all, feed, topic or instrument", `SCOPE=TOPIC`), `id` ("topic code, feed name or instrument id", `FED`), `limit` ("10–50 headlines", `N=50`), `kinds` ("story, video, filing, press_release, fed_release", `KIND=FILING`); sources `['bbg.rss','sec.atom','fed.rss']`; related `['N','NI','CN','DES','MSG']`.

#### Unavailable and reason codes
`{ field:'scope', reason:'NOT_APPLICABLE', detail:"UNKNOWN_SCOPE: '<id>' is neither a topic code, a feed nor an instrument id" }` (falls back to `all`); `{ field:'feedHealth.<sourceId>', reason:'NO_SOURCE', detail:'PROVIDER_DOWN: serving stored headlines' }` when a read-through circuit is open; `{ field:'feedHealth.sec.atom', reason:'NO_SOURCE', detail:'NO_READ_THROUGH_SEC_ATOM: 8-K headlines refresh only on the scheduler tick' }` whenever the `sec.atom` line is stale; `{ field:'rows[].rankParts.clickThrough', reason:'NO_SOURCE', detail:'NO_CLICKTHROUGH_HISTORY: fewer than 7 days of usage events' }`; `{ field:'rows[].summary', reason:'NOT_LICENSED', detail:'NO_BODY_LICENCE: headline, summary and link only — the article body is never stored' }` (always present for `bbg.rss` rows, rendered once in the footer). Entitlement: per-source `NO_FIRM_ENTITLEMENT` in `meta.entitlement` with the count in `suppressed.entitlement`; export-side `NOT_LICENSED_EXPORT` as a CSV header comment. `eod@demo` sees the full list — news is `field_class:'news'` and carries no latency tier, so `TIER_EOD` never applies here (ENTL-05).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/TOP.golden.test.ts` | seeded from `bbg-rss-{markets,econ,politics,tech,industries}`, `fed-press-rss.xml`, `sec-8k-atom.xml` at the frozen clock `2026-09-15T18:41:28Z`, deep-equals `TOP.default.json`; `rows[0].headline === "AI Will Be Biggest 'Misallocation' of Capital, Says Noble"`, `rows[0].sourceId === 'bbg.rss'`, `rows[0].feed === 'markets'`, `rows[0].kind === 'video'`, `rows[0].publishedAt === '2026-09-15T15:04:08.000Z'`, `rows[0].isCorrection === true`; the 8-K row has `kind:'filing'`, `cik:'0001590496'`, `items8k:['5.02']`, `publishedAt === '2026-09-15T18:21:20.000Z'`; every row `machineGenerated === false` |
| resolver unit | `packages/server/test/unit/functions/TOP.scope.test.ts` | `scope:'auto'` resolves `'FED'` → topic, `'markets'` → feed, `'42'` → instrument, `'zzz'` → `all` + the `UNKNOWN_SCOPE` unavailable entry; `kinds` filtering increments `suppressed.kindFilter` |
| ranker | `packages/server/test/unit/news/ranker.test.ts` | monotone in each `rankParts` component with the others fixed; ties break on `publishedAt` then `newsId`; `clickThrough === 0` with no `usage_events` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(TOP golden))` equals `TOP.default.csv`; `rank` column equals `rows[i].rank`; a source with `export_allowed=false` produces the `# suppressed` comment and omits those rows |
| parity | `packages/server/test/parity/fn-parity.test.ts` | `rows[0]` fields equal the `n:all` WS `snap` values (`NEWS_ID HEADLINE PUBLISHED_AT SOURCE_ID LINK KIND IS_CORRECTION`) at the frozen clock (API-05) |
| screen | `packages/web/test/screens/TOP.test.tsx` | renders the golden; an `n:all` `delta` prepends and flashes one row and the list stays at `limit`; `C`/`K`/`+`/`-` call `setParams`; `Enter` calls `ctx.openUrl` and emits `search.select`; a stale `feedHealth` row renders the amber chip; no row renders in the machine-generated block; skeleton |
| staleness | `packages/server/test/integration/functions/TOP.stale.test.ts` | with `ingest_runs` aged past `3 × expectedIntervalMs` and the circuit open, `feedHealth[i].st === 'stale'`, the `PROVIDER_DOWN` unavailable entry is present, rows are still served, nothing throws (TERM-12) |
| e2e | `packages/e2e/tests/news.spec.ts` | the morning flow: `TOP <GO>` paints ranked headlines; the replay feed pushes a headline that appears at the top within 1 s (NEWS-03); `Enter` opens the publisher URL in a new tab; `S` on a linked row lands on `DES`; `Ctrl+P` downloads `TOP_ALL_*.csv` |

---

### N — News Search

| Attribute | Value |
| --- | --- |
| Code / aliases | `N` / `NEWS` |
| Tier / category | 1 / news |
| Asset classes → variants | `any (optional security) → default` |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/N.ts` · `packages/server/src/functions/N/resolve.ts` · `packages/web/src/screens/N/Screen.tsx` · `fixtures/golden/functions/N.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (NEWS-01) (NEWS-02) (NEWS-07) (NEWS-08) (TERM-03) (TERM-06) (TERM-11) (TERM-12) (DATA-09) (DATA-10) (ENTL-01) (ENTL-05) (STOR-04) |

#### Params
```ts
export const NParams = z.object({
  q: z.string().max(200).optional(),                              // websearch_to_tsquery syntax: bare words, "phrases", -exclusions, OR
  scope: z.enum(['all', 'security']).default('all'),              // 'security' pins the query to the panel's loaded instrument (TERM-03)
  feeds: z.array(z.string().max(32)).default([]),
  topics: z.array(z.string().max(32)).default([]),                // topics.code
  kinds: z.array(z.enum(['story', 'video', 'filing', 'press_release', 'fed_release'])).default([]),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  pageSize: z.number().int().min(10).max(200).default(50),
  savedSearchId: z.number().int().optional(),                     // loads saved_searches.query and merges it under the explicit params
});
```
#### Argument grammar
`positional []`, `keyed { Q: { name:'q', type:'string' }, SCOPE: { name:'scope', type:'enum', values:['all','security'] }, FEED: { name:'feeds', type:'string', repeat:true }, TOPIC: { name:'topics', type:'string', repeat:true }, KIND: { name:'kinds', type:'enum', values:['story','video','filing','press_release','fed_release'], repeat:true }, FROM: { name:'from', type:'date' }, TO: { name:'to', type:'date' }, ROWS: { name:'pageSize', type:'int' }, SAVED: { name:'savedSearchId', type:'int' } }`, `rest { name:'q', type:'string', join:' ' }` — everything after the function code that is not a `KEY=value` token becomes the query text.
Examples: `N rate cut` → `{ q:'rate cut', scope:'all', pageSize:50 }` · `AAPL US Equity N` → `{ scope:'security', pageSize:50 }` with `security = 42` (a security in the panel flips the default scope to `security`, TERM-03) · `N Q="tender offer" KIND=FILING FROM=2026-09-01 ROWS=100` → `{ q:'tender offer', kinds:['filing'], from:'2026-09-01', pageSize:100 }`.

#### Payload
```ts
import type { NewsRow } from '../shared/news';                    // §0.2

export type NPayload = {
  variant: 'default';
  query: { q: string | null; instrumentId: number | null; instrumentDisplay: string | null; feeds: string[]; topics: string[];
           kinds: NewsRow['kind'][]; from: string | null; to: string | null };          // the query actually executed, after saved-search merge
  matcher: 'tsquery' | 'trigram' | 'none';                        // 'trigram' = websearch_to_tsquery matched 0 rows and pg_trgm on headline was used
  tsquery: string | null;                                         // websearch_to_tsquery(...)::text, echoed so the user can see what was searched
  rows: NewsRow[];                                                // published_at desc, newsId desc — never re-ranked (N is chronological, TOP is ranked)
  total: number;                                                  // capped at 1000 by the resolver; `totalIsCapped` says so
  totalIsCapped: boolean;
  nextCursor: string | null;                                      // base64url(JSON.stringify({ publishedAt, newsId })) of the last row
  savedSearch: { searchId: number; name: string } | null;
  feedHealth: TopPayload['feedHealth'];                           // same shape and rule as TOP (TERM-12)
  suppressed: { entitlement: number };
  asOf: string;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `news_items` (`tsv` — `setweight(headline,'A') || setweight(summary,'B')`, GIN; `pg_trgm` index on `headline` for the fallback), `news_entity_links` (instrument / topic filters), `topics`, `instruments` (current, for the display of `scope:'security'` and of `links[]`), `issuers` (link display), `saved_searches` (`kind='news'`), `provenance`, `licence_registry`, `ingest_runs` (`feedHealth`) |
| Data services (§1.4.2) | `data.news.search(NewsQuery)` (→ `GET /news`, returns `{ items, nextCursor, total }`), `data.reference.resolve(ref)` (only when `scope:'security'`), `data.news.topics()` (validating `params.topics`) |
| Read-through (`providers.ensure`) | None. A search reads the stored corpus only: a search must be reproducible and pageable, and refetching a feed mid-page would reorder results. Freshness is reported through `feedHealth`, and `R` re-runs the function (`launchKind:'refresh'`). |
| Engines (`core/analytics`) | None. |
| Subjects (live) | `n:inst:<instrumentId>` when `scope:'security'`; `n:topic:<code>` when exactly one topic and no `q`; `n:feed:<feed>` when exactly one feed and no `q`; otherwise **none** (a text query cannot be evaluated on the wire — the screen shows `text#livenote` "live prepend off for text queries; press R to re-run") |
| Field ids (`fieldIds(assetClass)`) | `default: []` — `n:` subjects subscribe with `f: []` (API.md §6.1). Entitlement pre-check is over sources `['bbg.rss','sec.atom','fed.rss']`, `field_class='news'` |

#### Resolver
1. Merge the query. When `params.savedSearchId` is set, load `saved_searches` (owner must be `ctx.user.userId`, else `ctx.unavailable.add({ field:'savedSearch', reason:'NOT_APPLICABLE', detail:'SAVED_SEARCH_NOT_YOURS' })` and continue without it); explicit params win field by field over the saved `query` jsonb.
2. Resolve the security. `scope:'security'` requires `ctx.security` (the panel's instrument, passed by `toRunRequest`); missing → `ctx.unavailable.add({ field:'query.instrumentId', reason:'NOT_APPLICABLE', detail:'NO_SECURITY_LOADED: N SCOPE=SECURITY needs a security in the panel' })` and fall back to `scope:'all'`. Present → `query.instrumentId = ctx.security.instrumentId`, `instrumentDisplay = ctx.security.display`.
3. Validate `params.topics` against `data.news.topics()`; each unknown code → `ctx.unavailable.add({ field:'query.topics', reason:'NOT_APPLICABLE', detail:'UNKNOWN_TOPIC: <code>' })` and is dropped. Same for `feeds` against the distinct `news_items.feed` values (`UNKNOWN_FEED: <feed>`).
4. `data.news.search({ q, instrumentId, topic, feed, kinds, from, to, cursor: ctx.page.cursor, limit: params.pageSize })`. The route runs `websearch_to_tsquery('english', q)` against `news_items.tsv`; when `q` is set and the tsquery returns 0 rows it re-runs with `headline % q` (pg_trgm, `similarity ≥ 0.3`, ordered by `published_at desc`) and the payload records `matcher:'trigram'`. `q` absent → `matcher:'none'` (pure filter query, chronological).
5. `total` is `count(*)` with `LIMIT 1001`; `total > 1000` → `total = 1000`, `totalIsCapped = true` (STOR-04: the corpus is unbounded, the count is not worth a full scan).
6. Licence filter and per-source access logging exactly as TOP step 5 (`purpose:'N'`); drops counted in `suppressed.entitlement`.
7. `feedHealth` exactly as TOP step 2 (shared helper `packages/server/src/functions/shared/feedHealth.ts`). No read-through (see the table).
8. Map to `NewsRow`; `provIdx` per row as TOP step 7. `machineGenerated` is `false` on every row (NEWS-08).
9. Paging: `nextCursor = base64url(JSON.stringify({ publishedAt: last.publishedAt, newsId: last.newsId }))`; `ctx.page.set({ index: ctx.page.index, count: Math.ceil(Math.min(total, 1000) / params.pageSize), cursor: nextCursor })`. **PAGE FWD = older headlines** (the sort is `published_at desc`), PAGE BACK re-runs with the previous cursor held in the frame stack. The cursor is a keyset, so a headline arriving mid-paging never duplicates or skips a row.
10. Return. Budget: 1 DB round-trip for the search (GIN or trigram index, both index-only on the first 50 rows), 1 for `feedHealth`, 1 for `saved_searches` when requested; first paint < 500 ms p95, 0 provider calls.

#### Live
`{ subjects: <zero or one subject per the Data-dependencies table>, fields: [], essential: [] }` or `null` when the query is textual. When a subject is present, `packages/web/src/screens/N/Screen.tsx` prepends an arriving headline **only when it satisfies the client-side filters it can evaluate** (`kinds`, `feeds`, `from`/`to`) and marks it with a `NEW` chip; it never re-sorts the page and never changes `total` (the count is the count at `asOf`). On page 2 and beyond (`ctx.page.index > 0`) live prepend is disabled, because prepending onto a keyset page would break the cursor contract; the screen says so in `text#livenote`.

#### Screen
```
┌ N · News Search · "rate cut" · all sources                     page 1/6 · 284 hits · tsquery · 18:41:28 ┐
│ form#query   q [rate cut          ] scope (all|security) feeds [markets,economics] topics [FED]         │
│              kinds [story,filing]  from [2026-09-01] to [ ]  rows [50]        saved: "Fed watch"        │
│ text#matcher  websearch_to_tsquery: 'rate' & 'cut'   ·  284 hits (exact)                                │
│ list#rows  (newsList('rows', rows, { showFeed:true, showKind:true, showSummary:true, highlight:tsquery }))│
│  15 Sep 13:55  FED  ◆  Federal Reserve Board announces …                              FED               │
│                        …summary with the matched terms marked…                                          │
│  15 Sep 11:02  ECO  ·  Traders Trim Bets on an October Cut                            USGG10YR Index    │
│ text#livenote  live prepend off for text queries — press R to re-run                                     │
│ footer sources: Bloomberg RSS (headline, summary and link only); SEC EDGAR 8-K Atom; Federal Reserve     │
│        press releases · page 1/6 · PAGE FWD = older · asOf 2026-09-15T18:41:28Z                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `N · News Search · <q ?? 'all headlines'> · <instrumentDisplay ?? 'all sources'>`; subtitle `page <index+1>/<count> · <total><totalIsCapped ? '+' : ''> hits · <matcher> · <asOf time>`; `initialFocus:'rows'` (`initialFocus:'query'` when `q` is absent and no filter is set, so an empty `N` lands in the form). `form#query` fields are `FormField`s (`q` text, `scope` enum, `feeds`/`topics`/`kinds` text with comma lists, `from`/`to` date, `pageSize` number); editing one and pressing `Enter` calls `ctx.setParams` (usage `fn.param`). `matcher:'trigram'` renders `text#matcher` in amber: `no exact match — showing approximate headline matches (pg_trgm)` with footer code `TRIGRAM_FALLBACK`. `matcher:'none'` hides the tsquery line. Matched terms are marked in headline and summary by the client from `tsquery` (`<mark>`-equivalent tone), never by the server. Skeleton: the form with the current params and twelve muted rows. `meta.entitlement` denials render as one muted line above the list with the source name and `NO_FIRM_ENTITLEMENT`.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | list (`list#rows`) | `open-story` | `ctx.openUrl(row.url)` (link-out only) + `usage_events { kind:'search.select', code:'N', details:{ newsId } }` |
| `Shift+Enter` | list | `open-story-next` | `ctx.navigateNext(row.links[0]?.display + ' DES')` when the row has an instrument link, else `ctx.openUrl(row.url)` |
| `Enter` | form (`form#query`) | `apply-query` | `ctx.setParams(form.values)` and reset to page 1 |
| `PageDown` / `PageUp` | always | reserved PAGE FWD / BACK | `ctx.page('fwd')` (older) / `ctx.page('back')` (newer) |
| `Ctrl+I` | list | reserved provenance | `ctx.provenance(row.provIdx)` (DATA-10) |
| `/` | always | `focus-query` | move focus to `form#query.q` |
| `R` | always | `refresh` | re-run with `launchKind:'refresh'` (no `fn.param` usage row, API.md §5.3) |
| `S` | always | `save-search` | `ctx.prompt('name')` → `sdk.alerts.savedSearches.create({ kind:'news', name, query })` (NEWS-07) — saved searches hang off the `alerts` namespace (`TerminalClient.alerts.savedSearches: SavedSearchesApi`, API.md §10 L1257); there is no top-level `sdk.savedSearches` |
| `A` | always | `alert-on-query` | `sdk.alerts.create({ condition: { kind:'news', savedSearchId } })` when saved, else `{ kind:'news', query: { q, instrumentId, topic, feed } }` (NEWS-07) |
| `K` | always | `cycle-kinds` | `ctx.setParams({ kinds })` cycling all → stories → filings |
| `T` | always | `open-top` | `ctx.navigate('TOP')` |
| `I` | always | `open-ni` | `ctx.navigate('NI ' + (query.topics[0] ?? ''))` |

#### CSV
`filename = 'N_' + (query.instrumentDisplay ? displaySlug + '_' : '') + (q ? slug(q) : 'ALL') + '_' + asOfCompact + '.csv'`. Columns = `newsCsvColumns` (§0.5) verbatim; rows = `rows.map(newsCsvRow)` — **the current page only**, and the header carries `# page: <index+1>/<count>` plus `# query: <JSON of payload.query>` and `# matcher: <matcher>` so an exported page is self-describing (FUNCTIONS.md §10 Q4). `Ctrl+E` on the list exports the same columns for up to 1000 rows across pages via `/data/csv` (the export path re-runs the query server-side with `limit: 1000`; the extra rows are entitlement-filtered again). Export licence filtering and the `# suppressed` comment are as TOP. Example row: `2026-09-15T18:21:20Z,sec.atom,8-K,filing,8-K · Aerkomm Inc. · Item 5.02,https://www.sec.gov/Archives/edgar/data/1590496/000121390026100070/0001213900-26-100070-index.htm,,false,1188`.

#### Help
summary `Full-text and filtered search over the normalised news stream`; description `N searches every headline and summary the platform has captured — Bloomberg RSS, SEC 8-K current filings and Federal Reserve press releases — using Postgres full-text search with the same stemming and phrase syntax as a web search: bare words are ANDed, "quoted phrases" are exact, a leading minus excludes, OR widens. When nothing matches exactly, N falls back to approximate headline matching and says so. Filters narrow by feed, topic, kind of item and date range; typing a security before N pins the search to that security's linked stories. Results are chronological, newest first — TOP is the ranked view. Pages move backwards in time: PAGE FWD shows older headlines. A search can be saved and turned into an alert that fires on the next matching headline. Article bodies are not stored; Enter opens the story at the publisher.`; params `q` ("search text, websearch syntax", `"tender offer" -earnings`), `scope` ("all or the panel's security", `SCOPE=SECURITY`), `feeds` ("feed names, repeatable", `FEED=markets`), `topics` ("topic codes, repeatable", `TOPIC=FED`), `kinds` ("item kinds, repeatable", `KIND=FILING`), `from` / `to` ("ISO dates", `FROM=2026-09-01`), `pageSize` ("10–200 rows", `ROWS=100`), `savedSearchId` ("load a saved search", `SAVED=3`); sources `['bbg.rss','sec.atom','fed.rss']`; related `['TOP','NI','CN','CF','DES']`.

#### Unavailable and reason codes
`{ field:'query.instrumentId', reason:'NOT_APPLICABLE', detail:'NO_SECURITY_LOADED: N SCOPE=SECURITY needs a security in the panel' }`; `{ field:'query.topics', reason:'NOT_APPLICABLE', detail:'UNKNOWN_TOPIC: <code>' }`; `{ field:'query.feeds', reason:'NOT_APPLICABLE', detail:'UNKNOWN_FEED: <feed>' }`; `{ field:'savedSearch', reason:'NOT_APPLICABLE', detail:'SAVED_SEARCH_NOT_YOURS' }`; `{ field:'rows', reason:'NO_SOURCE', detail:'TRIGRAM_FALLBACK: no exact match for the query; showing approximate headline matches' }` when `matcher === 'trigram'`; `{ field:'total', reason:'NOT_APPLICABLE', detail:'TOTAL_CAPPED_1000: more than 1000 matches; narrow the query' }` when `totalIsCapped`; `{ field:'rows[].summary', reason:'NOT_LICENSED', detail:'NO_BODY_LICENCE: headline, summary and link only' }` for `bbg.rss` rows; `{ field:'live', reason:'NOT_APPLICABLE', detail:'NO_LIVE_FOR_TEXT_QUERY: text queries cannot be evaluated on the wire' }` when `live()` returns `null`. Entitlement: per-source `NO_FIRM_ENTITLEMENT` with the count in `suppressed.entitlement`; export-side `NOT_LICENSED_EXPORT` as a CSV header comment. No latency tier applies to `field_class:'news'`, so `TIER_EOD` never appears (ENTL-05).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/N.golden.test.ts` | seeded from the five `bbg-rss-*`, `fed-press-rss.xml` and `sec-8k-atom.xml` at the frozen clock, deep-equals `N.default.json` for `N Q="capital"`: `matcher === 'tsquery'`, `tsquery === "'capit'"`, `rows[0].newsId` is the `TLEUW0KGZAKZ00` item, `rows` are strictly descending by `(publishedAt, newsId)`, `machineGenerated === false` on every row |
| resolver unit | `packages/server/test/unit/functions/N.query.test.ts` | saved-search merge order (explicit params win); unknown topic/feed dropped with the `UNKNOWN_*` unavailable entry; `scope:'security'` without `ctx.security` degrades to `all` with `NO_SECURITY_LOADED`; `AAPL US Equity N` filters to `news_entity_links` rows for instrument 42 with `confidence ≥ 0.9` only (NEWS-02) |
| trigram fallback | `packages/server/test/integration/functions/N.trigram.test.ts` | `q:'misalocation'` (typo) returns 0 tsquery rows, then ≥ 1 trigram row, `matcher === 'trigram'`, the `TRIGRAM_FALLBACK` unavailable entry is present |
| paging | `packages/server/test/integration/functions/N.page.test.ts` | `pageSize 10` over the seeded corpus: `meta.page.count === ceil(total/10)`; the page-1 cursor decodes to `{ publishedAt, newsId }` of row 10; PAGE FWD returns strictly older rows with no overlap; inserting a newer headline between pages changes neither page 2's rows nor `total` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(N golden))` equals `N.default.csv`; every column matches `newsCsvColumns`; the `# page` and `# query` comment lines are present |
| parity | `packages/server/test/parity/fn-parity.test.ts` | for `AAPL US Equity N`, `rows[0]` equals the `n:inst:42` WS `snap` values at the frozen clock (API-05) |
| screen | `packages/web/test/screens/N.test.tsx` | renders the golden; `form#query` edit + `Enter` calls `setParams` and resets the page; `PageDown` calls `ctx.page('fwd')`; `S` prompts and calls `alerts.savedSearches.create`; `A` calls `alerts.create`; `matcher:'trigram'` renders the amber notice; live prepend is suppressed on page 2; skeleton |
| e2e | `packages/e2e/tests/news.spec.ts` | continuing the morning flow: from `TOP`, `N` with `Q="Fed"` returns hits; `PageDown` shows older headlines and the footer page counter advances; `S` saves "Fed watch" and `A` arms an alert that the replayed feed fires into the `alerts:me` stream (NEWS-07) |

---

### NI — News by Topic

| Attribute | Value |
| --- | --- |
| Code / aliases | `NI` / `NEWSI` |
| Tier / category | 1 / news |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/NI.ts` · `packages/server/src/functions/NI/resolve.ts` · `packages/web/src/screens/NI/Screen.tsx` · `fixtures/golden/functions/NI.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (NEWS-01) (NEWS-02) (NEWS-03) (NEWS-07) (NEWS-08) (TERM-02) (TERM-06) (TERM-12) (DATA-09) (DATA-10) (ENTL-01) (ENTL-05) (STOR-04) |

#### Params
```ts
export const NiParams = z.object({
  topic: z.string().max(32).optional(),                           // topics.code, case-insensitive on input; absent → the browser
  limit: z.number().int().min(10).max(100).default(40),
  kinds: z.array(z.enum(['story', 'video', 'filing', 'press_release', 'fed_release'])).default([]),
  includeChildren: z.boolean().default(true),                     // roll child topics (topics.parent_topic_id) into the headline list
});
```
#### Argument grammar
`positional [{ name:'topic', type:'string', optional:true }]`, `keyed { N: { name:'limit', type:'int' }, KIND: { name:'kinds', type:'enum', values:['story','video','filing','press_release','fed_release'], repeat:true }, CHILDREN: { name:'includeChildren', type:'boolean' } }`, no `rest`.
Examples: `NI` → `{ limit:40, kinds:[], includeChildren:true }` (topic browser, no topic selected) · `NI FED` → `{ topic:'FED' }` · `NI TECH N=100 CHILDREN=N` → `{ topic:'TECH', limit:100, includeChildren:false }`.
Topic codes are in the autocomplete universe snapshot (TERM-02, FUNCTIONS.md §3.1), so `NI FE` offers `NI FED`.

#### Payload
```ts
import type { NewsRow } from '../shared/news';                    // §0.2

/** One node of the topic browser; `count24h` is the headline count in the last 24 h at asOf. */
export interface NiTopicNode {
  topicId: number; code: string; name: string; kind: 'feed' | 'sector' | 'theme' | 'region' | 'event' | 'release';
  parentCode: string | null; childCodes: string[];
  linkMethods: Array<'feed_topic' | 'keyword' | 'manual'>;        // how headlines reach this topic — [] means no source (see reason codes)
  count24h: number; count7d: number; lastPublishedAt: string | null;
  reason: 'TOPIC_NO_SOURCE' | null;                               // set when linkMethods is empty
}

export type NiPayload = {
  variant: 'default';
  topics: NiTopicNode[];                                          // the whole tree, parents before children, alphabetical within a level
  selected: NiTopicNode | null;                                   // null → browser only, `rows` is []
  rolledCodes: string[];                                          // selected.code plus its descendants when includeChildren
  rows: NewsRow[];                                                // published_at desc, newsId desc; [] when selected === null
  liveSubject: string | null;                                     // 'n:topic:<code>' when a topic is selected, else null
  feedHealth: TopPayload['feedHealth'];                           // same shape and rule as TOP (TERM-12)
  suppressed: { entitlement: number; kindFilter: number };
  asOf: string;
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `topics` (`topic_id`, `code`, `name`, `kind`, `parent_topic_id`, `keywords`), `news_entity_links` (`entity_kind='topic'`, `method IN ('feed_topic','keyword','manual')`, `confidence ≥ 0.9`), `news_items` (headlines and the `count24h`/`count7d` aggregates), `instruments` / `issuers` (current, for `links[].display`), `provenance`, `licence_registry`, `ingest_runs` (`feedHealth`) |
| Data services (§1.4.2) | `data.news.topics()` (the tree), `data.news.search({ topic, kinds, limit })` (headlines for the rolled codes) |
| Read-through (`providers.ensure`) | `('bbg.rss', feed, { maxAgeMs: 60_000 })` for the feed behind the selected topic when that `feedHealth` line is not `live` and `usage !== 'export'`; `('fed.rss', 'press_all', { maxAgeMs: 300_000 })` for `FED`. None for keyword/theme topics and none for `FILINGS` (no `sec.atom` read-through kind). |
| Engines (`core/analytics`) | None. |
| Subjects (live) | `n:topic:<code>` for the selected topic (`null` in the browser) |
| Field ids (`fieldIds(assetClass)`) | `default: []` — `n:` subjects subscribe with `f: []` (API.md §6.1); entitlement pre-check over sources `['bbg.rss','sec.atom','fed.rss']`, `field_class='news'` |

#### Resolver
1. `tree = await data.news.topics()` → `NiTopicNode[]`. `linkMethods` per topic comes from the seeded mapping in `packages/server/src/news/entityLink.ts`:

   | Topic codes | Method | Source of the link |
   | --- | --- | --- |
   | `MARKETS` `ECO` `POLITICS` `TECH` `WEALTH` `INDUSTRIES` | `feed_topic` (confidence 1.0) | the Bloomberg RSS feed the item arrived on (`news_items.feed`) |
   | `FED` | `feed_topic` (1.0) | `fed.rss` `press_all` |
   | `FILINGS` | `feed_topic` (1.0) | `sec.atom` 8-K current filings |
   | `RATES` `FX` `AI` | `keyword` (0.9) | whole-word match of `topics.keywords` against `headline` (`entityLink.ts` is precision-first: whole words only, headline only, never the summary — NEWS-02) |
   | `EARNINGS` `CA` | — (empty) | no feed and no reliable keyword set in v1 |

2. `count24h` / `count7d` / `lastPublishedAt`: one grouped query over `news_entity_links` ⋈ `news_items` for `entity_kind='topic'` within the two windows ending at `ctx.asOf.validAt`. A topic with `linkMethods.length === 0` gets `count* = 0`, `lastPublishedAt = null`, `reason:'TOPIC_NO_SOURCE'` and `ctx.unavailable.add({ field:'topics.' + code, reason:'NO_SOURCE', detail:'TOPIC_NO_SOURCE: no feed and no keyword set maps to this topic in v1' })` — the node is still listed, greyed, so the absence is visible rather than invented.
3. No `params.topic` → `selected = null`, `rows = []`, `liveSubject = null`; return after step 7 (the browser is the whole screen).
4. `params.topic` uppercased, matched on `topics.code`. No match → `ctx.unavailable.add({ field:'topic', reason:'NOT_APPLICABLE', detail:'UNKNOWN_TOPIC: <code>' })`, `selected = null` (the browser renders with the notice). `selected.reason === 'TOPIC_NO_SOURCE'` → `rows = []`, `liveSubject = 'n:topic:<code>'` is still returned (a future source would stream into it) and the screen shows the reason instead of an empty list.
5. `rolledCodes = includeChildren ? [code, ...descendants(code)] : [code]` (`topics.parent_topic_id`, depth ≤ 3).
6. `feedHealth` and the read-through for the selected topic's source exactly as TOP steps 2–3.
7. `rows = await data.news.search({ topic: rolledCodes, kinds: params.kinds, limit: params.limit + 20 })`, then the `kinds` filter (`suppressed.kindFilter`) and the licence filter with per-source access logging (`purpose:'NI'`, `suppressed.entitlement`) exactly as TOP step 5; truncate to `params.limit`; `provIdx` per row as TOP step 7; `machineGenerated` is `false` on every row (NEWS-08).
8. Return. Budget: 3 DB round-trips (tree, counts, headlines) plus at most 1 provider call; first paint < 500 ms p95.

#### Live
`{ subjects: payload.liveSubject ? [payload.liveSubject] : [], fields: [], essential: payload.liveSubject ? [payload.liveSubject] : [] }`, or `null` when `selected === null`. `n:` is not conflated, so `packages/web/src/screens/NI/Screen.tsx` prepends one row per `delta`, flashes it (TERM-08), caps the list at `params.limit` and increments the selected node's `count24h` in `grid#topics` so the browser column stays consistent with the list. NEWS-03 budget: receipt → screen < 1 s.

#### Screen
```
┌ NI · News by Topic · FED · Federal Reserve                        40 headlines · 24h 12 · 7d 61 · 18:41:28 ┐
│ split col [0.28 | 0.72]                                                                                    │
│ grid#topics                          │ list#rows (newsList('rows', rows, { showFeed:true, showKind:true })) │
│  code   name              24h   7d   │  13:55  FED  ◆  Federal Reserve Board announces …                    │
│  MARKETS Markets           20   131  │  11:30  FED  ◆  Minutes of the Federal Open Market Committee …       │
│  ECO     Economics         14    96  │  09:02  FED  ◆  Speech by Governor … on the economic outlook         │
│ ▸FED     Federal Reserve   12    61  │                                                                      │
│  FILINGS Filings           40   240  │                                                                      │
│  EARNINGS Earnings          —     —  │  text#topicreason (when the selected topic has no source):            │
│  CA      Corporate actions  —     —  │   TOPIC_NO_SOURCE — no feed and no keyword set maps to this topic     │
│ badges#health  [fed.rss 18:12:40 live] [bbg.rss markets live] [sec.atom STALE 20m]                          │
│ footer sources: Federal Reserve press releases; Bloomberg RSS; SEC EDGAR 8-K Atom · asOf 2026-09-15T18:41:28Z│
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Title `NI · News by Topic · <selected.code> · <selected.name>` (`NI · News by Topic · browse` when `selected === null`); subtitle `<rows.length> headlines · 24h <count24h> · 7d <count7d> · <asOf time>`; `initialFocus:'topics'` when `selected === null`, `'rows'` otherwise. `grid#topics` columns: `code` (`fmt:'text'`, child rows indented two spaces under their parent), `name`, `count24h` and `count7d` (`fmt:'int'`, `—` when the node has `reason:'TOPIC_NO_SOURCE'`), `lastPublishedAt` (`fmt:'datetime'`, shown only when the panel is ≥ 100 cols). The selected row is marked `▸` and `tone:'highlight'`; sourceless nodes are `tone:'muted'` with the reason in the cell tooltip. `list#rows` is empty-but-explained in two cases: `TOPIC_NO_SOURCE` (text above) and a topic with a source but no headline in the window (`no headlines for <code> in the captured corpus`). Skeleton: the topic grid with thirteen muted rows and ten muted list rows. `meta.entitlement` denials render as a muted line above the list.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid (`grid#topics`) | `select-topic` | `ctx.setParams({ topic: row.code })` (usage `fn.param`) |
| `Shift+Enter` | grid | `select-topic-next` | `ctx.navigateNext('NI ' + row.code)` |
| `Enter` | list (`list#rows`) | `open-story` | `ctx.openUrl(row.url)` (link-out only) + `usage_events { kind:'search.select', code:'NI', details:{ newsId } }` |
| `Shift+Enter` | list | `open-security` | `ctx.navigateNext(row.links.find(l => l.entityKind === 'instrument')?.display + ' DES')` when linked |
| `Ctrl+I` | grid, list | reserved provenance | `ctx.provenance(row.provIdx)` for a headline; on a topic row, the provenance of the feed behind it (DATA-10) |
| `C` | always | `toggle-children` | `ctx.setParams({ includeChildren: !includeChildren })` |
| `K` | always | `cycle-kinds` | `ctx.setParams({ kinds })` cycling all → stories → filings |
| `+` / `-` | always | `more` / `fewer` | `ctx.setParams({ limit: clamp(limit ± 20, 10, 100) })` |
| `A` | always | `alert-on-topic` | `sdk.alerts.create({ condition: { kind:'news', query: { topic: selected?.code } } })` (NEWS-07); no selection → `notice` |
| `N` | always | `open-n` | `ctx.navigate('N TOPIC=' + (selected?.code ?? ''))` — the same topic in the searchable reader |
| `T` | always | `open-top` | `ctx.navigate('TOP ' + (selected?.code ?? ''))` |
| `Home` / `End` | grid | `first-topic` / `last-topic` | move the grid cursor |

#### CSV
`filename = 'NI_' + (selected?.code ?? 'BROWSE') + '_' + asOfCompact + '.csv'`. Multi-block long format (§1.6 rule 3): a leading `section` column over the union of both blocks' columns. `section:'topic'` rows use `code,name,kind,parentCode,linkMethods,count24h,count7d,lastPublishedAt,reason` (one row per `topics[]`, in tree order); `section:'news'` rows use `newsCsvColumns` (§0.5) with `newsCsvRow(r)` (one row per `rows[]`). Columns are therefore payload-independent and static: `section` + the nine topic columns + the nine news columns, with the block that does not own a column left empty. Export licence filtering and the `# suppressed` comment are as TOP; the topic block is never suppressed (counts are ours, not the publisher's). Examples: `topic,FED,Federal Reserve,feed,,feed_topic,12,61,2026-09-15T17:55:00Z,,,,,,,,,` and `news,,,,,,,,,2026-09-15T17:55:00Z,fed.rss,press_all,fed_release,Federal Reserve Board announces …,https://www.federalreserve.gov/newsevents/pressreleases/…,FED,false,1203`.

#### Help
summary `Browse the topic tree and read the headline feed for one topic`; description `NI is the topic browser: every topic the platform links headlines to, with how many arrived in the last 24 hours and 7 days, and the headline list for the topic you select. Topics reach headlines two ways — a feed mapping, where every item from a publisher feed belongs to the topic, and a keyword match on the headline, which is deliberately narrow so a topic never collects stories it does not own. Topics that have neither are listed greyed with the reason rather than shown empty: nothing on this screen is inferred. Selecting a topic streams new headlines into the list as they arrive. Press N to search inside the topic, T for the ranked view, A to be alerted on the next headline.`; params `topic` ("topic code", `FED`), `limit` ("10–100 headlines", `N=100`), `kinds` ("item kinds, repeatable", `KIND=FILING`), `includeChildren` ("roll child topics into the list", `CHILDREN=N`); sources `['bbg.rss','sec.atom','fed.rss']`; related `['TOP','N','CN','ECO','FED']`.

#### Unavailable and reason codes
`{ field:'topic', reason:'NOT_APPLICABLE', detail:'UNKNOWN_TOPIC: <code>' }` (browser renders, no selection); `{ field:'topics.<code>', reason:'NO_SOURCE', detail:'TOPIC_NO_SOURCE: no feed and no keyword set maps to this topic in v1' }` — always emitted for `EARNINGS` and `CA` in v1, and the node carries `reason:'TOPIC_NO_SOURCE'` (footer code `TOPIC_NO_SOURCE`); `{ field:'rows', reason:'NO_SOURCE', detail:'NO_HEADLINES_IN_CORPUS: <code> has a source but no captured headline in the window' }`; `{ field:'feedHealth.<sourceId>', reason:'NO_SOURCE', detail:'PROVIDER_DOWN: serving stored headlines' }`; `{ field:'feedHealth.sec.atom', reason:'NO_SOURCE', detail:'NO_READ_THROUGH_SEC_ATOM: 8-K headlines refresh only on the scheduler tick' }` (so `NI FILINGS` can be up to one scheduler interval behind and says so); `{ field:'rows[].summary', reason:'NOT_LICENSED', detail:'NO_BODY_LICENCE: headline, summary and link only' }` for `bbg.rss` rows. Entitlement: per-source `NO_FIRM_ENTITLEMENT` with the count in `suppressed.entitlement`; export-side `NOT_LICENSED_EXPORT` as a CSV header comment; `TIER_EOD` never applies to `field_class:'news'` (ENTL-05).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/NI.golden.test.ts` | `NI FED` at the frozen clock deep-equals `NI.default.json` from `fed-press-rss.xml` + the five `bbg-rss-*` + `sec-8k-atom.xml`: `selected.code === 'FED'`, `selected.linkMethods === ['feed_topic']`, every row `sourceId === 'fed.rss'`, rows strictly descending by `(publishedAt, newsId)`, `topics` contains all thirteen seeded codes in tree order, the `EARNINGS` and `CA` nodes have `linkMethods: []`, `count24h === 0` and `reason === 'TOPIC_NO_SOURCE'`, and `meta.unavailable` carries the two matching `TOPIC_NO_SOURCE` entries |
| resolver unit | `packages/server/test/unit/functions/NI.topics.test.ts` | `includeChildren` rolls descendants to depth 3 into `rolledCodes` and no further; `NI` with no topic returns `selected === null`, `rows === []`, `liveSubject === null` and a fully populated tree; `NI ZZZ` returns the `UNKNOWN_TOPIC` entry and still renders the tree |
| entity linking | `packages/server/test/unit/news/entityLink.test.ts` | `feed_topic` links every `bbg-rss-markets` item to `MARKETS` at confidence 1.0; the `keyword` method links only on whole words in the headline (`"rates"` links `RATES`, `"generates"` does not) and never from the summary; no link below 0.9 is written (NEWS-02) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(NI golden))` equals `NI.default.csv`; both `section` blocks present; the topic block's `count24h` equals `topics[i].count24h`; the news block's columns equal `newsCsvColumns` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | `rows[0]` equals the `n:topic:FED` WS `snap` values at the frozen clock (API-05) |
| screen | `packages/web/test/screens/NI.test.tsx` | renders the golden; `Enter` on a topic row calls `setParams({ topic })`; a sourceless node renders muted with `—` counts and the `TOPIC_NO_SOURCE` text instead of an empty list; an `n:topic:FED` delta prepends, flashes and increments `count24h`; `C`/`K`/`+`/`-` call `setParams`; skeleton |
| e2e | `packages/e2e/tests/news.spec.ts` | closing the morning flow: `NI <GO>` paints the topic tree; `Enter` on `FED` loads its headlines and the URL-visible params change; the replayed `fed.rss` headline appears at the top within 1 s (NEWS-03); `NI CA <GO>` shows the greyed `TOPIC_NO_SOURCE` panel with no fabricated rows |

---
