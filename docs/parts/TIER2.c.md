### CN — Company News

| Attribute | Value |
| --- | --- |
| Code / aliases | `CN` / `CNEWS` (no `aliasParams`) |
| Tier / category | 2 / news |
| Asset classes → variants | `equity, etf → issuer; index → members` |
| requiresSecurity / pageable / screenKind | `true` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CN.ts` · `packages/server/src/functions/CN/resolve.ts` · `packages/web/src/screens/CN/Screen.tsx` · `fixtures/golden/functions/CN.issuer.{json,csv}`, `fixtures/golden/functions/CN.members.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (NEWS-01) (NEWS-02) (NEWS-04) (NEWS-08) (STOR-04) (DATA-10) (TERM-08) (TERM-12) (ENTL-05) (API-05) |

**Variants (FUNC-02).** `issuer` (equity, etf) shows every headline and filing linked to the *issuer* of the security on screen — so `AAPL US Equity CN` and a hypothetical second Apple line both show the same stream — ordered newest first, with the filings of that CIK folded in as pseudo-headlines. `members` (index) shows the union stream of the index's largest constituents (`params.members` of them, by `index_members.weight`), each row tagged with which members it is linked to; it is the "what moved my index today" screen and never shows unlinked market-wide headlines.

#### Params
```ts
export const CnParams = z.object({
  window: z.enum(['1D', '3D', '1W', '1M', '3M', '1Y']).default('1M'),
  kinds: z.array(z.enum(['story', 'video', 'filing', 'press_release', 'fed_release'])).default(['story', 'video', 'filing', 'press_release']),
  q: z.string().max(200).optional(),                 // websearch_to_tsquery over news_items.tsv, ANDed with the entity link
  minConfidence: z.number().min(0.9).max(1).default(0.9),   // news_entity_links.confidence floor; < 0.9 is never written (NEWS-02)
  members: z.number().int().min(5).max(50).default(25),     // index variant only: how many constituents by weight
  limit: z.number().int().min(10).max(200).default(50),
});
```
#### Argument grammar
`positional [{ name:'window', type:'enum', values:['1D','3D','1W','1M','3M','1Y'], optional:true }, { name:'q', type:'string', optional:true }]`, `keyed { K: { name:'kinds', type:'enum', values:['story','video','filing','press_release','fed_release'], repeat:true }, CONF: { name:'minConfidence', type:'number' }, M: { name:'members', type:'int' }, N: { name:'limit', type:'int' } }`, `rest { name:'q', type:'string', join:' ' }`.
Examples: `AAPL US Equity CN` → `{ window:'1M', kinds:['story','video','filing','press_release'], minConfidence:0.9, members:25, limit:50 }` · `AAPL US Equity CN 1W buyback` → `{ window:'1W', q:'buyback' }` · `SPX Index CN 1D K=FILING M=50` → `{ window:'1D', kinds:['filing'], members:50 }`.

#### Payload
```ts
import type { NewsRow } from '../shared/news';                 // FUNCTIONS_TIER1.md §0.2 — reused unchanged

/** A filing rendered as a headline (NEWS-04). Not a news_items row: `newsId` is null and `accessionNo` identifies it. */
export interface CnFilingRow {
  newsId: null; accessionNo: string;
  headline: string;                                             // '8-K — Results of Operations and Financial Condition (Item 2.02)'
  summary: string | null;                                       // filings.primary_doc_desc
  sourceId: 'sec.submissions'; feed: 'edgar'; kind: 'filing';
  author: null; category: string /* the form: '8-K' */; cik: string; items8k: string[] | null;
  publishedAt: string /* filings.accepted_at */; capturedAt: string /* filings.captured_at */;
  url: string; isCorrection: boolean /* form ends with '/A' */; machineGenerated: false;
  links: NewsRow['links'];                                      // exactly one issuer link, confidence 1.0, method 'cik'
  provIdx: number;
}
export type CnRow = NewsRow | CnFilingRow;                       // discriminated by `newsId === null`

export type CnPayload =
  | { variant: 'issuer';
      security: { instrumentId: number; key: string /* 'AAPL US Equity' */; name: string };
      issuer: { issuerId: number | null; name: string; cik: string | null };
      window: { from: string; to: string; label: '1D' | '3D' | '1W' | '1M' | '3M' | '1Y' };
      rows: CnRow[];                                             // newest first by publishedAt, tie-broken by newsId/accessionNo desc
      counts: { story: number; video: number; filing: number; press_release: number; fed_release: number };
      total: number; liveSubject: string /* 'n:inst:42' */;
      notes: string[] }                                          // 'PRECISION_FIRST_LINKING', 'BODY_NOT_STORED_LINK_OUT', 'NO_ISSUER_HEADLINES_IN_WINDOW'
  | { variant: 'members';
      index: { instrumentId: number; key: string /* 'SPX Index' */; name: string; indexId: number };
      membership: { asOfDate: string; sourceId: 'sec.archives' | 'ssga.holdings'; shown: number; total: number; provIdx: number };
      window: { from: string; to: string; label: '1D' | '3D' | '1W' | '1M' | '3M' | '1Y' };
      rows: Array<CnRow & { members: Array<{ instrumentId: number; key: string; weight: number | null }> }>;
      counts: { story: number; video: number; filing: number; press_release: number; fed_release: number };
      total: number; liveSubjects: string[] /* ['n:inst:42', …] */;
      notes: string[] };
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `news_items` (`tsv`, `published_at`), `news_entity_links` (`confidence ≥ params.minConfidence`), `topics`, `filings`, `instruments` (as-of), `issues`, `issuers` (as-of), `identifiers` (scheme `CIK`), `index_members` (as-of `ctx.asOf`), `indices`, `provenance` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.members`, `data.news.search`, `data.filings.list` |
| Read-through (`providers.ensure`) | `('bbg.rss', feed, { maxAgeMs: 300_000 })` for each feed in `topics` of kind `feed` when the newest `news_items.captured_at` is older than 5 min; `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` before the filings fold-in |
| Engines (`core/analytics`) | None. |
| Subjects (live) | `issuer`: `n:inst:<instrumentId>` · `members`: `n:inst:<memberInstrumentId>` for each shown member (≤ 50) |
| Field ids (`fieldIds(assetClass)`) | `equity, etf, index: [NEWS_ID, HEADLINE, PUBLISHED_AT, SOURCE_ID, LINK, KIND, IS_CORRECTION]` — the `n:` family of API.md §6.1, `fieldClass:'news'` |

#### Resolver
`issuer` (default `resolve`, also `variants.equity` and `variants.etf`):
1. `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `issuerId = inst.issuer.issuerId`, `cik = inst.issuer.cik`. `window.to = ISO(ctx.asOf.validAt)`; `window.from = to − {1D:1, 3D:3, 1W:7, 1M:30, 3M:91, 1Y:365} days`.
2. `await ctx.providers.ensure('bbg.rss', feed, { maxAgeMs: 300_000 })` for every feed of BRIEF §2 (`markets, economics, politics, technology, wealth, industries`) whose newest stored `captured_at` is older than 5 min; a `{ fresh:false }` answer leaves the stored rows and marks the run stale through `ctx.prov.add({ …, st:'stale' })` (TERM-12).
3. `news = await ctx.data.news.search({ issuerId, instrumentId: issuerId === null ? inst.instrumentId : undefined, kinds: params.kinds, q: params.q, from: window.from, to: window.to, cursor: ctx.page?.cursor ?? undefined, limit: params.limit })`. The service joins `news_entity_links` with `confidence ≥ params.minConfidence` and orders `published_at DESC, news_id DESC`. Each item becomes a `NewsRow` unchanged (shared type, §0.2) with `provIdx = ctx.prov.add({ sourceId: item.sourceId, provenanceId: item.provenanceId, capturedAt, sourceTs: publishedAt, st:'closed', tier:'delayed' })`.
4. Filings fold-in (NEWS-04), only when `params.kinds` contains `'filing'` and `cik !== null`: `await ctx.providers.ensure('sec.submissions', cik, { maxAgeMs: 21_600_000 })`, then `f = await ctx.data.filings.list(cik, { from: window.from.slice(0,10), to: window.to.slice(0,10), limit: params.limit })`. Every `Filing` whose `accession_no` is not already the `provider_guid` of a fetched `news_items` row (the 8-K atom feed writes `urn:tag:sec.gov,2008:accession-number=…`) becomes a `CnFilingRow`: `headline = form + ' — ' + (itemLabels.join('; ') || primaryDocDesc || 'filing')` where `itemLabels` comes from `EIGHT_K_ITEMS` (see *Unavailable and reason codes*); `publishedAt = accepted_at`; `links = [{ entityKind:'issuer', entityId: issuerId, display: inst.issuer.name, confidence: 1.0, method:'cik' }]`; `isCorrection = form.endsWith('/A')`; one `ctx.prov.add` per submissions capture.
5. Merge `news` and the filing rows, sort `publishedAt DESC` then `(newsId ?? 0) DESC` then `accessionNo DESC`, truncate to `params.limit`. `counts` = per-`kind` tally of the merged, untruncated set; `total` = `news.total + foldedFilings`.
6. `ctx.page.set({ index: pageIndex, count: total, cursor: rows.length ? base64url(JSON.stringify({ publishedAt: last.publishedAt, newsId: last.newsId, accessionNo: (last as CnFilingRow).accessionNo ?? null })) : null })`. PAGE FWD = older headlines.
7. `notes`: always `'PRECISION_FIRST_LINKING'` and `'BODY_NOT_STORED_LINK_OUT'`; when `rows.length === 0` also `'NO_ISSUER_HEADLINES_IN_WINDOW'` plus `ctx.unavailable.add({ field:'rows', reason:'NO_SOURCE', detail:'NO_ISSUER_HEADLINES_IN_WINDOW: no headline in the Bloomberg RSS feeds was linked to this issuer at confidence ≥ 0.9 in the window (NEWS-02 is precision-first); widen the window or press F for filings only' })`. `cik === null` → `ctx.unavailable.add({ field:'filings', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' })` and no fold-in.
8. Return `{ variant:'issuer', …, liveSubject: 'n:inst:' + inst.instrumentId }`.
Budget: 2 DB round-trips (news page, filings page) + 1 for the instrument; < 200 ms p95 warm.

`members` (`variants.index`):
1. `m = await ctx.data.reference.members(ctx.instrument.instrumentId)` → `membership.asOfDate`, `membership.sourceId`, `membership.total = m.members.length`; take the `params.members` largest by `weight` → `shown`; one `ctx.prov.add` for the membership file (`tier:'eod'`, `st:'closed'`).
2. `news = await ctx.data.news.search({ instrumentIds: shownIds, kinds: params.kinds, q: params.q, from, to, cursor, limit: params.limit })` (`instrumentIds` — see *additions required*). Each row's `members` array is built from the row's own `links` filtered to `entityKind==='instrument'` and `entityId ∈ shownIds`, carrying each member's `weight`.
3. No filings fold-in (an index has no CIK of its own); `params.kinds` containing `'filing'` still matches `news_items` rows of kind `filing` that are linked to a member.
4. `notes`: `'PRECISION_FIRST_LINKING'`, `'BODY_NOT_STORED_LINK_OUT'`, `'MEMBER_SUBSET'` (only `shown` of `total` constituents are searched) and, when `membership.asOfDate` is more than 45 days before `ctx.asOf.validAt`, `'MEMBERSHIP_STALE'`. Empty result → `ctx.unavailable.add({ field:'rows', reason:'NO_SOURCE', detail:'NO_ISSUER_HEADLINES_IN_WINDOW: no headline linked to the top N constituents in the window' })`.
5. `ctx.page.set` as in the `issuer` variant; `liveSubjects = shownIds.map(id => 'n:inst:' + id)`.
Budget: 2 DB round-trips; < 300 ms p95 warm.

#### Live
`issuer`: `{ subjects: [payload.liveSubject], fields: [], conflationMs: 0 }` — `n:` subjects take `f: []` ("all fields of the subject", API.md §6.1) and are **never conflated**: one `delta` per headline in `publishedAt` order (BUS-02). `members`: `{ subjects: payload.liveSubjects, fields: [], conflationMs: 0 }`.
The screen holds no `Cell.live`: the list node carries `live: { subject }` and `packages/web/src/screens/CN/Screen.tsx` prepends an arriving headline to `list#rows` (flash for 400 ms, TERM-08) only when its `KIND` is in `params.kinds` and its `PUBLISHED_AT` is inside the window; the counter badge increments. `packages/web/src/state/subscriptions.ts` maps `n:` to `'*'` before sending `sub` (§0.4 rule 5).

#### Screen
```
issuer
┌ CN · AAPL US Equity · Apple Inc · Company News ────────────────────────────────┐
│ badges#window [1M · 2026-08-16..2026-09-15] [story 12 · filing 7] [LIVE]        │
│ badges#notes  [PRECISION-FIRST LINKING] [LINK-OUT ONLY] [STALE when applicable] │
│ list#rows (newsList shared helper, FUNCTIONS_TIER1.md §0.1)                      │
│   primary   = headline (text)                                                   │
│   secondary = sourceId · feed · linked keys ('AAPL US Equity|Apple Inc')         │
│   ts        = publishedAt (datetime, 'YYYY-MM-DD HH:MM' local exchange tz)       │
│   badges    = [kind] [CORRECTION when isCorrection] [8-K items when items8k]     │
│   url       = url (Enter opens; bodies are never stored)                         │
│ footer: sources ['Bloomberg RSS (headline and link only)', 'SEC EDGAR submissions'] asOf=validAt │
└─────────────────────────────────────────────────────────────────────────────────┘
members
┌ CN · SPX Index · S&P 500 · Member News ────────────────────────────────────────┐
│ badges#window [1D · top 25 of 503 by weight · membership 2026-06-30 sec.archives]│
│ grid#rows  time (datetime) | member (key, frozen) | wt% (pct 2dp) | kind         │
│            | headline (left, elastic) | source                                   │
│            frozenColumns 2; a headline linked to several members repeats per link │
│ footer: sources ['Bloomberg RSS (headline and link only)', 'SEC EDGAR N-PORT']    │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `CN · <display> · <name> · Company News` (`members`: `· Member News`); subtitle `<window.label> · <counts.story + counts.filing …> items`. `initialFocus:'rows'`. Skeleton while `payload === undefined`: `badges#window` with one muted badge and 12 muted list rows (`members`: 12 muted grid rows). `meta.unavailable` renders as a `text#empty` node with `tone:'warn'` carrying the `detail` verbatim — an empty stream always states *why* it is empty, never a bare "no results". `meta.entitlement` denials on the `news` field class replace the list with a `badges#blocked` row (`tone:'blocked'`) naming the `ReasonCode` (ENTL-05). `meta.staleness === 'stale'` adds a `stale`-toned badge to `badges#notes` and the header shows the last `capturedAt` (TERM-12). `machineGenerated` is `false` on every row in v1; the screen still renders such rows in a separate, labelled block if one ever appears (NEWS-08).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid / list | `open-story` | `ctx.openUrl(row.url)` (publisher site; bodies are never stored) |
| `Shift+Enter` | grid / list | `open-des-next` | `ctx.navigateNext(row.links[0].display + ' DES')` for an instrument link, else the issuer's primary instrument |
| `W` | always | `cycle-window` | `1D → 3D → 1W → 1M → 3M → 1Y → 1D` via `ctx.setParams({ window })` (usage `fn.param`) |
| `F` | always | `toggle-filings` | `setParams({ kinds: kinds.includes('filing') ? kinds.filter(k => k !== 'filing') : [...kinds, 'filing'] })` |
| `S` | always | `only-stories` | `setParams({ kinds: ['story', 'video'] })` |
| `/` | always | `search-within` | `ctx.prompt('text', { label:'Search headlines' })` → `setParams({ q })` |
| `A` | always | `save-alert` | `ctx.prompt('text', { label:'Alert name' })` → `sdk.alerts.create({ kind:'news', query: { instrumentId, topic: null } })` (NEWS-07) |
| `C` | always | `open-cacs` | `ctx.navigate('CACS')` |
| `Delete` | always | `open-cf` | `ctx.navigate('CF')` — the full filings list |
| `M` | grid (members) | `more-members` | `setParams({ members: clamp(members + 25, 5, 50) })` |
| `Ctrl+I` is the reserved provenance key (§2.6) and shows the row's `provIdx` entry: source, `captured_at`, request URL. |

#### CSV
`filename = 'CN_' + display.replace(/ /g,'_') + '_' + window.label + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
`issuer`: the shared `newsCsvColumns` of `packages/core/src/functions/shared/news.ts` (§0.5) **unchanged**, so a CN export is byte-comparable with TOP/N/NI; rows are `payload.rows.map(newsCsvRow)` with one adaptation for `CnFilingRow` — `newsId` is empty and the accession number goes in the `sourceId` column's sibling: `newsCsvRow` is called on the row as-is and the exporter appends nothing, because `CnFilingRow.newsId` is `null` (rule 2: `null` → empty) and `url` already contains the accession path. One extra static column is appended after `newsId`: `{ id:'accessionNo', label:'Accession', type:'string' }` (empty for true headlines). Example: `2026-07-31T20:31:00Z,sec.submissions,edgar,filing,"8-K — Results of Operations and Financial Condition (Item 2.02)",https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm,Apple Inc,false,,0000320193-26-000020`.
`members`: the same columns prefixed by `{ id:'memberKey', label:'Member', type:'string' }` and `{ id:'memberWeight', label:'Weight', type:'number', decimals:6 }`; a headline linked to *k* members emits *k* rows (one table per document, §1.6 rule 1). Example: `AAPL US Equity,0.071200,2026-09-15T12:04:00Z,bbg.rss,markets,story,"Apple Supplier Signals Strong iPhone Demand",https://www.bloomberg.com/news/articles/…,AAPL US Equity,false,88213,`.

#### Help
summary `Headlines and filings linked to this issuer, precision-first` (62 chars); description `CN shows every headline linked to the issuer of the security on the command line, newest first, with that issuer's SEC filings folded in as headlines. Linking is precision-first: a story appears only when it was matched to the company by CIK, exact ticker or exact name at confidence 0.9 or better, so a story that merely mentions the company in its body will not appear. Headlines are from Bloomberg's public RSS feeds and carry a link only — no article body is stored or served. Press W to widen the window, F to show or hide filings, / to search within the result and A to save an alert. On an index, CN shows the union stream of the largest constituents, tagged with which member each story belongs to.`; params: `window` ("1D, 3D, 1W, 1M, 3M or 1Y", example `CN 1W`), `q` ("search within the headlines", `CN 1M buyback`), `kinds` ("story, video, filing, press_release, fed_release", `K=FILING`), `minConfidence` ("link-confidence floor, 0.9–1.0", `CONF=1`), `members` ("index only: constituents to search, 5–50", `M=50`), `limit` ("rows per page, 10–200", `N=100`); sources `['bbg.rss', 'sec.submissions', 'sec.atom', 'sec.archives', 'ssga.holdings']`; related `['N', 'TOP', 'NI', 'CF', 'CACS', 'DES']`.

#### Unavailable and reason codes
`{ field:'rows', reason:'NO_SOURCE', detail:'NO_ISSUER_HEADLINES_IN_WINDOW: no headline in the Bloomberg RSS feeds was linked to this issuer at confidence ≥ 0.9 in the window (NEWS-02 is precision-first); widen the window or press F for filings only' }` — the expected state for most single names, because the reachable feeds are market-wide, not per-issuer wires · `{ field:'filings', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' }` · `{ field:'summary', reason:'NOT_LICENSED', detail:'BODY_NOT_STORED_LINK_OUT: Bloomberg RSS is link-out only; the article body is never stored or served (DATA_MODEL §10)' }` emitted once per run · footer notes `PRECISION_FIRST_LINKING`, `MEMBER_SUBSET` (index: only `shown` of `total` constituents searched), `MEMBERSHIP_STALE` (N-PORT/SSGA membership older than 45 days). Item labels for 8-K pseudo-headlines come from `EIGHT_K_ITEMS` in `packages/core/src/functions/shared/secForms.ts`; an item code absent from that map renders as `'Item <code>'` and adds note `ITEM_LABEL_UNKNOWN`. Entitlement: `NO_FIRM_ENTITLEMENT` / `NO_USER_ENTITLEMENT` on the `news` field class replaces the list with the blocked badge; `SOURCE_TIER_CAP` never applies (news has no tier ladder). `PROVIDER_DOWN` (circuit open, stored rows) → `meta.staleness:'stale'`, rows still served.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/CN.golden.test.ts` | AAPL (id 42) from `bbg-rss-markets`, `bbg-rss-tech`, `sec-submissions-AAPL.json` at the frozen clock deep-equals `CN.issuer.json`; SPX Index from the same feeds + `sec-nport-SPY-primary_doc.xml` equals `CN.members.json`; SPY US Equity asserted inline as `variant:'issuer'` |
| resolver unit | `packages/server/test/unit/functions/CN.merge.test.ts` | seeded `news_items` + `filings`: an 8-K present in both `sec.atom` (`provider_guid` accession) and `filings` appears exactly once; merge order is `publishedAt DESC, newsId DESC`; `minConfidence=1` drops a 0.95 name-exact link |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(CN.issuer.json))` equals `CN.issuer.csv` and likewise `CN.members`; every `publishedAt` cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at the frozen clock (API-05) |
| screen | `packages/web/test/screens/CN.test.tsx` | both goldens render; `W`/`F`/`S`/`/` call `setParams`; Enter calls `openUrl`; `list#rows` registers `live: { subject:'n:inst:42' }`; an `n:` delta prepends and flashes; `payload undefined` renders the skeleton |
| empty stream | `packages/server/test/integration/functions/CN.empty.test.ts` | an issuer with no links returns `rows: []`, note `NO_ISSUER_HEADLINES_IN_WINDOW` and a `meta.unavailable` entry; the screen test asserts the warn text is visible, not a bare "no results" |
| paging | `packages/server/test/integration/functions/CN.page.test.ts` | `limit:10` over 25 seeded rows: `meta.page.cursor` round-trips through `POST /functions/CN/page { direction:'fwd' }`, returns strictly older rows, no duplicates, `count` stable |
| e2e | `packages/e2e/tests/command-line.spec.ts` (new step) | `AAPL US Equity CN <GO>` renders the stream; `W` twice changes the window badge and the row count; Enter opens the publisher URL in a new tab |

---

### CACS — Corporate Actions

| Attribute | Value |
| --- | --- |
| Code / aliases | `CACS` / `CA`, `ACTIONS` (no `aliasParams`) |
| Tier / category | 2 / reference |
| Asset classes → variants | `equity, etf → issuer; index → members` |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CACS.ts` · `packages/server/src/functions/CACS/resolve.ts` · `packages/web/src/screens/CACS/Screen.tsx` · `fixtures/golden/functions/CACS.issuer.{json,csv}`, `fixtures/golden/functions/CACS.members.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-08) (REF-03) (REF-09) (REF-10) (DATA-10) (STOR-06) (TERM-12) (ENTL-05) (API-05) |

**Variants (FUNC-02).** `issuer` (equity, etf) is the timeline of every `corporate_actions` row for that instrument inside the window — cash and special dividends, splits and reverse splits, name and ticker changes, plus the earnings dates taken from 8-K item 2.02 filings — each row carrying its `status` on the estimated → announced → confirmed → paid ladder (DATA-08) and the price-adjustment factor it contributes (REF-09). `members` (index) is the forward calendar: every ex-date of the index's constituents inside the window, weighted, so a PM can see the index's dividend drag; it shows no earnings rows and no history before `ctx.asOf.validAt − 7 days`.

#### Params
```ts
export const CacsParams = z.object({
  from: z.iso.date().optional(),                     // default: validAt − 2 years (issuer) / validAt − 7 days (members)
  to: z.iso.date().optional(),                       // default: validAt + 90 days
  types: z.array(z.enum(['cash_dividend', 'special_dividend', 'stock_dividend', 'split', 'reverse_split', 'spinoff', 'merger',
                         'tender', 'rights', 'call', 'conversion', 'name_change', 'ticker_change', 'delisting', 'capital_return']))
          .default(['cash_dividend', 'special_dividend', 'stock_dividend', 'split', 'reverse_split', 'name_change', 'ticker_change']),
  status: z.array(z.enum(['estimated', 'announced', 'confirmed', 'paid', 'cancelled'])).default(['announced', 'confirmed', 'paid']),
  includeEarnings: z.boolean().default(true),        // issuer variant: 8-K item 2.02 dates on the same timeline
  includeProjected: z.boolean().default(true),       // resolver-derived next ex-date, always status 'estimated'
  members: z.number().int().min(5).max(100).default(50),      // index variant only
  knownAt: z.iso.datetime().optional(),              // PIT override (STOR-06, REF-03); undefined = ctx.asOf.knownAt
});
```
#### Argument grammar
`positional [{ name:'from', type:'date', optional:true }, { name:'to', type:'date', optional:true }]`, `keyed { T: { name:'types', type:'enum', values:[…the fifteen ca_type values…], repeat:true }, ST: { name:'status', type:'enum', values:['estimated','announced','confirmed','paid','cancelled'], repeat:true }, E: { name:'includeEarnings', type:'boolean' }, P: { name:'includeProjected', type:'boolean' }, M: { name:'members', type:'int' }, KNOWN: { name:'knownAt', type:'datetime' } }`, no `rest`.
Examples: `AAPL US Equity CACS` → `{ types:[7 defaults], status:['announced','confirmed','paid'], includeEarnings:true, includeProjected:true, members:50 }` · `AAPL US Equity CACS 2020-01-01 T=SPLIT T=REVERSE_SPLIT` → `{ from:'2020-01-01', types:['split','reverse_split'] }` · `SPX Index CACS M=100 E=0` → `{ members:100, includeEarnings:false }`.

#### Payload
```ts
export type CaType = 'cash_dividend' | 'special_dividend' | 'stock_dividend' | 'split' | 'reverse_split' | 'spinoff' | 'merger'
                   | 'tender' | 'rights' | 'call' | 'conversion' | 'name_change' | 'ticker_change' | 'delisting' | 'capital_return';
export type CaStatus = 'estimated' | 'announced' | 'confirmed' | 'paid' | 'cancelled';

/** One row of the timeline. Field names mirror API.md §5.1 `CorporateAction` exactly, plus the four screen-only fields. */
export interface CacsAction {
  caId: number | null;                                          // null on a projected row (never written to corporate_actions)
  instrumentId: number; key: string; caType: CaType; status: CaStatus;
  declaredDate: string | null; exDate: string; recordDate: string | null; payDate: string | null; effectiveDate: string | null;
  amount: number | null; currency: string | null; ratioNew: number | null; ratioOld: number | null;
  newInstrumentId: number | null; newKey: string | null;
  frequency: string | null; grossOrNet: 'gross' | 'net'; details: Record<string, unknown>; note: string | null;
  sourceId: string;                                             // 'yahoo.chart' | 'sec.submissions' | 'internal.user' | 'internal.derived'
  reviewState: 'auto' | 'queued' | 'reviewed' | 'rejected';     // REF-10 dual key
  adjFactor: number | null;                                     // core/adjust/corporateActions.ts price factor this row contributes
  projected: boolean; projectionBasis: string | null;           // 'median gap of last 8 cash dividends = 91 d'
  provIdx: number;
}
export type CacsPayload =
  | { variant: 'issuer';
      security: { instrumentId: number; key: string; name: string; currency: string };
      issuer: { issuerId: number | null; name: string; cik: string | null };
      window: { from: string; to: string }; knownAt: string;
      actions: CacsAction[];                                     // ex-date DESC for past, ASC for future; see resolver step 7
      earnings: Array<{ accessionNo: string; form: string; filedAt: string; acceptedAt: string; reportDate: string | null;
                        items8k: string[]; reportTiming: 'pre' | 'post' | 'intraday' | 'unknown'; url: string; provIdx: number }>;
      summary: { ttmCashDividend: number | null; ttmCount: number; frequency: string | null;
                 dvdYield: ValueCell; pxLast: ValueCell;         // DVD_YIELD = ttmCashDividend / PX_LAST × 100 (TIER1 §0.3)
                 lastSplit: { exDate: string; ratioNew: number; ratioOld: number } | null;
                 nextProjected: { exDate: string; amount: number | null; basis: string; confidence: number } | null;
                 cumulativeAdjFactor: number };                  // product of adjFactor over the window (REF-09 policy 'price')
      counts: Partial<Record<CaType, number>>;
      notes: string[] }                                          // 'ESTIMATED_CA_UNAVAILABLE', 'CA_TYPES_NO_SOURCE', 'PROJECTED_ROW', 'CA_REVIEW_PENDING'
  | { variant: 'members';
      index: { instrumentId: number; key: string; name: string; indexId: number };
      membership: { asOfDate: string; sourceId: 'sec.archives' | 'ssga.holdings'; shown: number; total: number; provIdx: number };
      window: { from: string; to: string }; knownAt: string;
      actions: Array<CacsAction & { weight: number | null; weightedAmount: number | null }>;   // weightedAmount = amount × weight
      summary: { exDateCount: number; weightedCashPerIndexUnit: number | null; coverage: number };  // coverage = members with ≥1 known action ÷ shown
      notes: string[] };
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `corporate_actions` (bitemporal, read `bt_as_of(valid_from, valid_to, tx_from, tx_to, validAt, knownAt)`), `instruments` (as-of), `issues`, `issuers` (as-of; `former_names` for name changes), `identifiers` (scheme `CIK`, `TICKER_EXCH`), `filings` (8-K with `items @> '{2.02}'`), `index_members` (as-of), `indices`, `quote_snapshots` (plant warm start), `bars_daily` (ex-date close for the adjustment factor), `provenance` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.reference.corporateActions` (**addition required**, see below), `data.reference.members`, `data.filings.list`, `plant.subjectFor`, `plant.snapshot`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | `('yahoo.daily', providerSymbol, { maxAgeMs: 86_400_000 })` — the `range=max&interval=1d&events=div%7Csplit` call that populates `corporate_actions` from `yahoo-chart-events`; `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` for earnings dates and `former_names` |
| Engines (`core/analytics`) | `packages/core/src/adjust/corporateActions.ts` (DATA_MODEL §6.1) for `adjFactor` and `cumulativeAdjFactor`; registered in `meta.engines` as `{ name:'adjust/corporateActions', version:'1.0.0', inputsHash }` (ANAL-08) |
| Subjects (live) | `issuer`: `q:<instrumentId>` (for `pxLast`/`dvdYield`) · `members`: None. |
| Field ids (`fieldIds(assetClass)`) | `equity, etf: [CA_TYPE, CA_STATUS, CA_DECLARED_DT, CA_EX_DT, CA_RECORD_DT, CA_PAY_DT, CA_AMOUNT, CA_RATIO, DVD_SH_12M, DVD_YIELD, PX_LAST]` · `index: [CA_TYPE, CA_STATUS, CA_EX_DT, CA_AMOUNT, CA_RATIO, IDX_MEMBER_WEIGHT]` |

#### Resolver
`issuer` (default `resolve`, also `variants.equity` and `variants.etf`):
1. `knownAt = params.knownAt ? min(new Date(params.knownAt), ctx.asOf.knownAt) : ctx.asOf.knownAt` (a user may look back, never forward of the request's `knownAt`, STOR-06). `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`. `window.from = params.from ?? ISO_DATE(validAt − 2 years)`, `window.to = params.to ?? ISO_DATE(validAt + 90 days)`.
2. `await ctx.providers.ensure('yahoo.daily', mdLine.providerSymbol, { maxAgeMs: 86_400_000 })` when `corporate_actions` has no row for the instrument with `valid_from` inside the last 24 h; `{ fresh:false }` with stored rows → `ctx.prov.add({ …, st:'stale' })` and `meta.staleness:'stale'` (TERM-12).
3. `rows = await ctx.data.reference.corporateActions(inst.instrumentId, { from: window.from, to: window.to, types: params.types, status: params.status, validAt: ctx.asOf.validAt, knownAt })`. The reader applies `bt_as_of(...)` and orders `ex_date`. Each row maps 1:1 onto `CacsAction` using the `corporate_actions` column names of DATA_MODEL §6 (`ca_id → caId`, `ca_type → caType`, `ratio_new/ratio_old → ratioNew/ratioOld`, `review_state → reviewState`), `key` from `instruments.ticker` + sector, `newKey` resolved from `new_instrument_id` when present, `provIdx = ctx.prov.add({ sourceId: row.sourceId, provenanceId: row.provenanceId, capturedAt, sourceTs: null, st:'closed', tier:'eod' })`.
4. `adjFactor` per row from `core/adjust/corporateActions.ts` under policy `'price'`: `split`/`reverse_split`/`stock_dividend` → `ratioOld / ratioNew`; `cash_dividend`/`special_dividend` → `1 − amount / close(ex_date − 1 session)` read from `bars_daily`, `null` when that close is missing (note `ADJ_FACTOR_NO_CLOSE`); every other `ca_type` → `null`. `cumulativeAdjFactor` is the product of the non-null factors with `ex_date ≤ validAt`. `ctx.engines.add({ name:'adjust/corporateActions', version:'1.0.0', inputsHash: sha256(canonicalJson({ instrumentId, window, policy:'price', caIds })) })`.
5. Name and ticker changes (no `yahoo.chart` event exists for them): after `ensure('sec.submissions', cik, 6 h)`, each entry of `issuers.former_names` (`[{name, from, to}]`) whose `to` falls inside the window becomes a `CacsAction` with `caType:'name_change'`, `status:'confirmed'`, `exDate = to`, `effectiveDate = to`, `details: { fromName, toName }`, `sourceId:'sec.submissions'`, `caId: null`, `projected:false`; ticker changes come from `identifiers` versions of scheme `TICKER_EXCH` whose `valid_to` is finite inside the window, `caType:'ticker_change'`, `details: { fromTicker, toTicker }`. Both are included only when `params.types` names them.
6. `earnings` (when `params.includeEarnings`): `data.filings.list(cik, { forms:['8-K','8-K/A'], from: window.from, to: window.to, limit: 100 })` filtered to `items ∋ '2.02'`; `reportTiming` from the ET hour of `accepted_at` (`< 09:30 → 'pre'`, `≥ 16:00 → 'post'`, else `'intraday'`), `'unknown'` when `accepted_at` is null — the identical rule EE uses, so EE and CACS never disagree.
7. Ordering: `actions` are returned with the future block first (ex-date ascending, `exDate > validAt`) then the past block (ex-date descending) so the screen's initial viewport is "what is coming".
8. Projection (when `params.includeProjected` and ≥ 4 `cash_dividend` rows exist): `gaps` = differences between consecutive `ex_date`; `nextProjected = { exDate: lastExDate + median(gaps), amount: lastAmount, basis: 'median gap of last ' + n + ' cash dividends = ' + median + ' d', confidence: n >= 8 ? 0.6 : 0.4 }` and, unless a real announced row already covers that date, one extra `CacsAction` with `caId: null`, `status:'estimated'`, `sourceId:'internal.derived'`, `reviewState:'auto'`, `projected: true`, `projectionBasis = basis`. It is **never** written to `corporate_actions` and is always badged on screen. Fewer than 4 rows → `nextProjected: null`, note `PROJECTION_INSUFFICIENT_HISTORY`.
9. `summary.pxLast`: `subject = plant.subjectFor(inst.instrumentId)`; `plant.ensureHot([subject])`; `state = plant.snapshot(subject)`; `pxLast = cellFromState(ctx, state, 'PX_LAST', subject)` (TIER1 §0.4 rule 1). `ttmCashDividend` = sum of `amount` over `cash_dividend`/`special_dividend` rows with `ex_date` in the trailing 365 days and status ∈ {announced, confirmed, paid} (the `DVD_SH_12M` definition of TIER1 §0.3); `dvdYield` is a derived cell (`st:'closed'`, `provIdx` of the newest contributing dividend, `live: { subject, field:'DVD_YIELD' }`) equal to `ttmCashDividend / pxLast.v × 100`, or `{ v: null, st:'na' }` when either input is null.
10. `notes` and `ctx.unavailable.add` for every requested `ca_type` with no reachable source — see *Unavailable and reason codes*. Rows with `reviewState === 'queued'` add note `CA_REVIEW_PENDING` (REF-10).
Budget: 3 DB round-trips (instrument, actions, filings) + 1 for `bars_daily` closes; zero provider calls when warm; < 250 ms p95.

`members` (`variants.index`):
1. `m = await ctx.data.reference.members(ctx.instrument.instrumentId)`; take the `params.members` largest by `weight` → `membership.shown`; one `ctx.prov.add` for the membership file (`tier:'eod'`).
2. `window.from = params.from ?? ISO_DATE(validAt − 7 days)`, `window.to = params.to ?? ISO_DATE(validAt + 90 days)`; one `ctx.data.reference.corporateActions` call per batch of member ids (the reader accepts an id array — see *additions required*), `types` restricted to the cash and split families.
3. `weight` from the member row; `weightedAmount = amount === null ? null : amount × weight`; `summary.weightedCashPerIndexUnit` = sum of `weightedAmount` over rows with `exDate > validAt`, `null` when every member's amount is null; `coverage = members with ≥ 1 row ÷ shown`, rendered as a percentage so the screen states how much of the index it actually knows about.
4. `includeEarnings` is ignored (`notes: ['EARNINGS_NOT_APPLICABLE_INDEX']`); `includeProjected` applies per member exactly as in step 8.
Budget: 2 DB round-trips; < 350 ms p95.

#### Live
`issuer`: `{ subjects: ['q:' + payload.security.instrumentId], fields: ['PX_LAST'], conflationMs: 1000 }` — only `summary.pxLast` and the derived `summary.dvdYield` carry `Cell.live`; the timeline itself is static reference data. `members`: `null`.

#### Screen
```
issuer
┌ CACS · AAPL US Equity · Apple Inc · Corporate Actions ─────────────────────────┐
│ kv#summary  TTM dividend 1.04 USD (4 payments, quarterly) · yield 0.31% (live)  │
│             last split 4:1 2020-08-31 · cumulative adj factor 0.24866           │
│             next (projected) 2026-11-07 est. 0.26 — conf 0.6                    │
│ badges#notes [KNOWN AT 2026-09-15] [ESTIMATED CA UNAVAILABLE] [PROJECTED ROW]    │
│              [MERGER/TENDER/RIGHTS/CALL: NO SOURCE] [REVIEW PENDING when queued] │
│ grid#actions  ex-date (date, frozen) | type | status badge | amount (ccy 4dp)    │
│               | ratio ('4:1') | declared (date) | record (date) | pay (date)     │
│               | adj factor (number 5dp) | source | review                        │
│               future rows above the rule, tone 'highlight'; projected rows tone  │
│               'muted' with a [PROJECTED] badge and the basis in the title attr   │
│ grid#earnings  reported (datetime) | timing badge pre/post | form | items | link │
│ footer: sources ['Yahoo Finance chart events (unofficial)', 'SEC EDGAR submissions'] asOf=validAt knownAt=<knownAt> │
└─────────────────────────────────────────────────────────────────────────────────┘
members
┌ CACS · SPX Index · S&P 500 · Member Corporate Actions ─────────────────────────┐
│ badges#scope [top 50 of 503 by weight · membership 2026-06-30 · coverage 78%]    │
│ grid#actions  ex-date (date, frozen) | member (key) | wt% (pct 2dp) | type       │
│               | status | amount (ccy 4dp) | weighted (ccy 6dp) | ratio | source  │
│               groupBy 'exDate'; group footer shows the day's weighted total      │
│ kv#summary  upcoming ex-dates 31 · weighted cash per index unit 1.84 · coverage 78% │
│ footer: sources ['Yahoo Finance chart events (unofficial)', 'SEC EDGAR N-PORT']   │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `CACS · <display> · <name> · Corporate Actions`; subtitle `<window.from> … <window.to> · knownAt <knownAt>`; `initialFocus:'actions'`. Skeleton while `payload === undefined`: `kv#summary` with 4 muted rows and `grid#actions` with 12 muted rows. `status` renders as a `Badge`: `estimated` → `info`, `announced` → `info`, `confirmed` → `ok`, `paid` → `ok` muted, `cancelled` → `error` with the row struck through. Every `meta.unavailable` entry becomes a badge in `badges#notes` whose `title` is the `detail` string, so an absent action type is visibly absent-with-a-reason rather than silently missing. A denied field (`meta.entitlement`) blanks its column with `—` and the `ReasonCode` in the tooltip (ENTL-05). `meta.staleness:'stale'` puts a `stale`-toned badge on `badges#notes` with the last `captured_at` (TERM-12).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid `actions` | `show-provenance` | opens a `kv` overlay with `sourceId`, `reviewState`, `caId`, the raw `details` JSON and the provenance request URL |
| `Shift+Enter` | grid `actions` | `open-target-next` | `ctx.navigateNext(row.newKey + ' DES')` when `newKey !== null` (spinoff child, merger acquirer, new ticker), else no-op |
| `Enter` | grid `earnings` | `open-filing` | `ctx.openUrl(row.url)` (the 8-K on sec.gov) |
| `T` | always | `cycle-types` | all → dividends only → splits only → all, via `setParams({ types })` |
| `U` | always | `toggle-status` | include/exclude `estimated` and `cancelled` in `setParams({ status })` |
| `P` | always | `toggle-projected` | `setParams({ includeProjected: !includeProjected })` |
| `K` | always | `set-known-at` | `ctx.prompt('date', { label:'Known at' })` → `setParams({ knownAt })` (STOR-06, REF-03) |
| `Home` / `End` | grid | `window-back` / `window-fwd` | `setParams({ from: from − 2 y })` / `setParams({ to: to + 1 y })` |
| `M` | grid (members) | `more-members` | `setParams({ members: clamp(members + 25, 5, 100) })` |
| `E` | always | `open-ee` | `ctx.navigate('EE')` |
| `G` | always | `open-gp` | `ctx.navigate('GP 5Y')` with dividend and split markers on (CHRT-06) |
| `Delete` | always | `open-cf` | `ctx.navigate('CF')` |

#### CSV
`filename = 'CACS_' + display.replace(/ /g,'_') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`.
`issuer`: long format (§1.6 rule 3 — the screen has three blocks) with a leading `section` column. Columns: `section,exDate,caType,status,amount,currency,ratioNew,ratioOld,declaredDate,recordDate,payDate,effectiveDate,adjFactor,newKey,frequency,grossOrNet,sourceId,reviewState,projected,projectionBasis,note,caId`. Sections in order: `action` (one row per `actions[]`), `earnings` (one row per `earnings[]`, with `exDate = acceptedAt.slice(0,10)`, `caType = 'earnings_8k'`, `note = items8k.join('|') + ' ' + reportTiming`, `sourceId = 'sec.submissions'`, `caId` = the accession number), `summary` (one row per summary key, `caType` = the key, `amount` = its value). Example: `action,2026-08-08,cash_dividend,paid,0.26,USD,,,2026-07-31,2026-08-11,2026-08-14,,0.99921,,quarterly,net,yahoo.chart,auto,false,,,88421`.
`members`: wide, one row per `actions[]`, columns `exDate,memberKey,weight,caType,status,amount,currency,weightedAmount,ratioNew,ratioOld,payDate,sourceId,reviewState,projected` plus a trailing `section`-prefixed summary block (`summary,exDateCount,…`) per §1.6 rule 3's "one block dominates" form. Example: `2026-09-18,MSFT US Equity,0.068400,cash_dividend,announced,0.91,USD,0.062244,,,2026-10-09,yahoo.chart,auto,false`.

#### Help
summary `Dividend, split, name-change and earnings timeline with status` (60 chars); description `CACS is the corporate-action timeline for the security on the command line. Upcoming actions sit above the rule, history below it, and each row shows where it is on the estimated, announced, confirmed, paid ladder together with the price-adjustment factor it contributes to adjusted history. Cash dividends and splits come from the exchange-event feed; name and ticker changes are derived from the issuer's own SEC record; earnings dates are the 8-K item 2.02 acceptance times. Rows badged PROJECTED are the resolver's own estimate of the next ex-date from the issuer's payment cadence, never a published announcement. Mergers, tenders, rights, calls and conversions have no reachable source in this build and are listed as unavailable with a reason rather than shown empty. Press K to see the timeline as it was known on an earlier date.`; params: `from` ("window start", example `CACS 2020-01-01`), `to` ("window end", `CACS 2020-01-01 2027-01-01`), `types` ("corporate-action types", `T=SPLIT`), `status` ("estimated, announced, confirmed, paid, cancelled", `ST=ANNOUNCED`), `includeEarnings` ("8-K item 2.02 dates", `E=0`), `includeProjected` ("projected next ex-date", `P=0`), `members` ("index only: constituents, 5–100", `M=100`), `knownAt` ("point-in-time date", `KNOWN=2025-01-01`); sources `['yahoo.chart', 'sec.submissions', 'sec.archives', 'ssga.holdings', 'internal.derived']`; related `['DES', 'EE', 'GP', 'HP', 'CF', 'CN']`.

#### Unavailable and reason codes
One `ctx.unavailable.add` per requested-but-unsourced `ca_type`, emitted every run so the gap is visible and machine-readable:
`{ field:'merger', reason:'NO_SOURCE', detail:'CA_TYPES_NO_SOURCE: no reachable source publishes merger terms; the yahoo.chart event feed carries dividends and splits only (BRIEF §2)' }` and the identical entry for `tender`, `rights`, `call`, `conversion`, `spinoff`, `delisting` and `capital_return` ·
`{ field:'status.estimated', reason:'NO_SOURCE', detail:'ESTIMATED_CA_UNAVAILABLE: the event feed publishes an action only after its ex-date, so pre-announcement (declared-but-not-ex) rows exist only for actions entered by data operations (internal.user); the PROJECTED row is the resolver\'s cadence estimate, not an announcement (DATA-08)' }` ·
`{ field:'adjFactor', reason:'NO_SOURCE', detail:'ADJ_FACTOR_NO_CLOSE: no bars_daily close on the session before the ex-date, so the cash-dividend factor cannot be computed' }` (per affected row) ·
`{ field:'actions', reason:'NO_SOURCE', detail:'instrument has no yahoo.chart market-data line, so no event history is reachable' }` ·
`{ field:'earnings', reason:'NOT_APPLICABLE', detail:'EARNINGS_NOT_APPLICABLE_INDEX: an index has no filings; see CACS on a member' }` (members variant).
Footer notes: `PROJECTED_ROW`, `PROJECTION_INSUFFICIENT_HISTORY` (fewer than 4 cash dividends), `CA_REVIEW_PENDING` (≥ 1 row with `review_state='queued'`, REF-10), `MEMBER_SUBSET`, `MEMBERSHIP_STALE`, `COVERAGE_PARTIAL` (members coverage < 100 %). Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on the `reference` field class blanks `amount`/`ratio`; `PROVIDER_DOWN` → `meta.staleness:'stale'` with stored rows served.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/CACS.golden.test.ts` | AAPL (id 42) seeded from `yahoo-chart-events` (dividends) + `sec-submissions-AAPL.json` at the frozen clock deep-equals `CACS.issuer.json`, including `cumulativeAdjFactor` and the projected row; SPX Index with `sec-nport-SPY-primary_doc.xml` membership equals `CACS.members.json` |
| resolver unit | `packages/server/test/unit/functions/CACS.adjust.test.ts` | against seeded fixtures: `4:1` split → `adjFactor 0.25`; a 0.26 dividend on a 331.59 prior close → `0.99922`; missing prior close → `null` + `ADJ_FACTOR_NO_CLOSE`; `cumulativeAdjFactor` equals the product used by `HP` under policy `price` (REF-09 single implementation) |
| projection | `packages/server/test/unit/functions/CACS.projection.test.ts` | 8 synthetic quarterly ex-dates → `confidence 0.6` and a median gap of 91 d; 4 rows → `0.4`; 3 rows → `nextProjected: null` + `PROJECTION_INSUFFICIENT_HISTORY`; the projected row never appears in `corporate_actions` after the run |
| point-in-time | `packages/server/test/integration/functions/CACS.pit.test.ts` | a dividend corrected from 0.25 to 0.26 by a second version filed 2026-08-20: `knownAt=2026-08-15` returns 0.25, `knownAt=now` returns 0.26; `GET /ref/:id/versions?table=corporate_actions` shows both (REF-03, STOR-06) |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(CACS.issuer.json))` equals `CACS.issuer.csv` and likewise `CACS.members`; every `amount` and `adjFactor` cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at the frozen clock (API-05) |
| screen | `packages/web/test/screens/CACS.test.tsx` | both goldens render; future rows precede past rows; `T`/`U`/`P`/`K` call `setParams`; a `queued` row shows the review badge; `summary.pxLast` registers `live: { subject:'q:42', field:'PX_LAST' }`; a `merger` `meta.unavailable` entry renders as a badge with the detail in its title; skeleton |
| unavailable | `packages/server/test/integration/functions/CACS.unavailable.test.ts` | a run with `types` containing `merger` emits the `CA_TYPES_NO_SOURCE` entry; an instrument with no `yahoo.chart` md_line returns `actions: []` with the reason |
| e2e | `packages/e2e/tests/fa-pit.spec.ts` (new step, continuing the FA/EE flow) | from `AAPL US Equity EE <GO>` press `C` → CACS loads with the same security; `K` set to 2025-01-01 changes the timeline; PRINT yields the long-format CSV whose `action` rows match the grid |

---

### CF — Company Filings

| Attribute | Value |
| --- | --- |
| Code / aliases | `CF` / `FILINGS` (no `aliasParams`) |
| Tier / category | 2 / fundamentals |
| Asset classes → variants | `equity, etf → issuer` |
| requiresSecurity / pageable / screenKind | `true` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CF.ts` · `packages/server/src/functions/CF/resolve.ts` · `packages/web/src/screens/CF/Screen.tsx` · `fixtures/golden/functions/CF.issuer.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-06) (NEWS-04) (STOR-06) (REF-03) (DATA-10) (TERM-12) (ENTL-05) (API-05) |

**Variants (FUNC-02).** One variant, `issuer`, for both `equity` and `etf` — an ETF is a filer like any other, only its form mix differs (`NPORT-P`, `N-CEN`, `N-30D`, `485BPOS` instead of `10-K`, `10-Q`, `8-K`), and the `formCounts` block makes that difference visible without a second code path. The `latest` block therefore names an `annual`/`quarterly`/`current8k` filing that is `null` for a fund, and the screen falls back to showing the newest three filings of the issuer's most common form.

#### Params
```ts
export const CfParams = z.object({
  forms: z.array(z.string().max(12)).max(12).default([]),      // [] = every form; matched case-insensitively against filings.form
  group: z.enum(['ALL', 'PERIODIC', 'CURRENT', 'OWNERSHIP', 'FUND', 'PROXY']).default('ALL'),   // form-group preset, expanded to `forms` by the resolver
  from: z.iso.date().optional(),                               // default: validAt − 3 years
  to: z.iso.date().optional(),                                 // default: validAt
  items: z.array(z.string().max(6)).max(12).default([]),       // 8-K item codes: ['2.02','5.02'] — filings.items @> items
  xbrlOnly: z.boolean().default(false),                        // filings.is_xbrl OR is_inline_xbrl
  limit: z.number().int().min(10).max(200).default(50),
  knownAt: z.iso.datetime().optional(),                        // PIT override (STOR-06); undefined = ctx.asOf.knownAt
});
```
#### Argument grammar
`positional [{ name:'group', type:'enum', values:['ALL','PERIODIC','CURRENT','OWNERSHIP','FUND','PROXY'], optional:true }]`, `keyed { F: { name:'forms', type:'string', repeat:true }, I: { name:'items', type:'string', repeat:true }, FROM: { name:'from', type:'date' }, TO: { name:'to', type:'date' }, X: { name:'xbrlOnly', type:'boolean' }, N: { name:'limit', type:'int' }, KNOWN: { name:'knownAt', type:'datetime' } }`, no `rest`.
Examples: `AAPL US Equity CF` → `{ forms:[], group:'ALL', items:[], xbrlOnly:false, limit:50 }` · `AAPL US Equity CF PERIODIC X=1` → `{ group:'PERIODIC', xbrlOnly:true }` · `AAPL US Equity CF F=8-K I=2.02 FROM=2024-01-01` → `{ forms:['8-K'], items:['2.02'], from:'2024-01-01' }`.
Group presets (`packages/core/src/functions/shared/secForms.ts`): `PERIODIC` → `['10-K','10-K/A','10-Q','10-Q/A','20-F','40-F']` · `CURRENT` → `['8-K','8-K/A','6-K']` · `OWNERSHIP` → `['3','4','5','SC 13D','SC 13D/A','SC 13G','SC 13G/A','13F-HR']` · `FUND` → `['NPORT-P','N-CEN','N-30D','485BPOS','497']` · `PROXY` → `['DEF 14A','DEFA14A','PRE 14A']` · `ALL` → `[]`.

#### Payload
```ts
export interface CfFiling {
  accessionNo: string;                                          // '0000320193-26-000020'
  form: string; formGroup: 'PERIODIC' | 'CURRENT' | 'OWNERSHIP' | 'FUND' | 'PROXY' | 'OTHER';
  filedDate: string;                                            // filings.filed_date (YYYY-MM-DD)
  acceptedAt: string | null;                                    // filings.accepted_at — the public-knowledge instant
  reportDate: string | null;                                    // filings.report_date (period of report)
  items: string[] | null;                                       // filings.items — 8-K item codes
  itemLabels: string[] | null;                                  // EIGHT_K_ITEMS lookup; 'Item <code>' when unknown
  primaryDoc: string; primaryDocDesc: string | null;
  isXbrl: boolean; isInlineXbrl: boolean; sizeBytes: number | null;
  url: string;                                                  // filings.url
  isAmendment: boolean;                                         // form ends with '/A'
  amends: string | null;                                        // accessionNo of the newest same-form filing with the same reportDate, when one exists
  provIdx: number;
}
export type CfPayload = {
  variant: 'issuer';
  security: { instrumentId: number; key: string; name: string; assetClass: 'equity' | 'etf' };
  issuer: { issuerId: number | null; name: string; cik: string | null; sic: string | null; sicDescription: string | null;
            filerCategory: string | null; fiscalYearEnd: string | null /* 'MMDD' */; entityType: string | null;
            formerNames: Array<{ name: string; from: string; to: string }>; website: string | null };
  filter: { forms: string[]; group: CfPayload['filter']['group']; items: string[]; xbrlOnly: boolean; from: string; to: string };
  filings: CfFiling[];                                          // accepted_at DESC, then accessionNo DESC
  formCounts: Array<{ form: string; formGroup: CfFiling['formGroup']; count: number; newest: string }>;   // over the whole window, not the page
  latest: { annual: CfFiling | null; quarterly: CfFiling | null; current8k: CfFiling | null; fundHoldings: CfFiling | null };
  coverage: { from: string | null; to: string | null; sourceId: 'sec.submissions'; recentOnly: boolean; countInStore: number };
  total: number; knownAt: string;
  notes: string[];                                              // 'FILING_FULLTEXT_UNAVAILABLE', 'DOCUMENT_NOT_STORED_LINK_OUT', 'HISTORY_LIMITED_RECENT_FILE'
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `filings` (primary), `issuers` (as-of; `cik`, `sic`, `sic_description`, `filer_category`, `fiscal_year_end`, `entity_type`, `former_names`, `website`), `identifiers` (scheme `CIK`), `instruments` (as-of), `issues`, `xbrl_facts` (existence probe for the XBRL badge), `fund_terms` (ETF `cik` when the issuer has none), `provenance` |
| Data services (§1.4.2) | `data.reference.instrument`, `data.filings.list` |
| Read-through (`providers.ensure`) | `('sec.submissions', cik, { maxAgeMs: 21_600_000 })` on every run whose newest stored `filings.captured_at` for the CIK is older than 6 h |
| Engines (`core/analytics`) | None. |
| Subjects (live) | None. |
| Field ids (`fieldIds(assetClass)`) | `equity, etf: [FILING_FORM, FILING_DT, FILING_ACCESSION_NO, FILING_ITEMS, FILING_IS_XBRL, FA_FILED_AT]` — `fieldClass:'fundamental'`, `sourceId:'sec.submissions'` |

#### Resolver
`issuer` (default `resolve`, also `variants.equity` and `variants.etf`):
1. `knownAt = params.knownAt ? min(new Date(params.knownAt), ctx.asOf.knownAt) : ctx.asOf.knownAt` (STOR-06). `inst = await ctx.data.reference.instrument(ctx.instrument.instrumentId)`; `cik = inst.issuer.cik ?? inst.terms?.kind === 'fund' ? inst.terms.cik : null` (a fund's CIK lives on `fund_terms` when the trust is not itself an issuer row). `cik === null` → `ctx.unavailable.add({ field:'filings', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' })` and return with `filings: []`, `formCounts: []`, `total: 0`.
2. `forms = params.forms.length ? params.forms : FORM_GROUPS[params.group]` (`ALL` → `[]`, meaning no form filter). `from = params.from ?? ISO_DATE(validAt − 3 years)`, `to = params.to ?? ISO_DATE(validAt)`.
3. `await ctx.providers.ensure('sec.submissions', cik, { maxAgeMs: 21_600_000 })`. `{ fresh:false }` with stored rows → `ctx.prov.add({ …, st:'stale' })` → `meta.staleness:'stale'` and the stale badge (TERM-12); a thrown `ProviderUnavailableError` with nothing stored propagates as `503 PROVIDER_UNAVAILABLE` (§1.4.2).
4. `page = await ctx.data.filings.list(cik, { forms: forms.length ? forms : undefined, from, to, cursor: ctx.page?.cursor ?? undefined, limit: params.limit })`, then in-resolver filtering that the service does not express: `params.items.length` keeps rows whose `items` is a superset of `params.items`; `params.xbrlOnly` keeps rows with `is_xbrl || is_inline_xbrl`. Each row maps onto `CfFiling` with `formGroup` from the reverse of `FORM_GROUPS`, `itemLabels` from `EIGHT_K_ITEMS`, `isAmendment = form.endsWith('/A')`, and `provIdx = ctx.prov.add({ sourceId:'sec.submissions', provenanceId: row.provenanceId, capturedAt: row.capturedAt, sourceTs: row.acceptedAt, st:'closed', tier:'eod' })` — one provenance entry per submissions capture, shared by every row it produced.
5. `amends`: for a row with `isAmendment`, the newest non-amendment filing with the same `form.replace('/A','')` and the same `reportDate`; `null` when none is stored.
6. `formCounts` is a second, aggregate query over the *whole* window (not the page): `count(*)` and `max(filed_date)` grouped by `form`, sorted by count desc then form asc — this is what makes the screen honest about an ETF's form mix without a second variant.
7. `latest`: newest `10-K`/`20-F`/`40-F` → `annual`; newest `10-Q` → `quarterly`; newest `8-K` → `current8k`; newest `NPORT-P` → `fundHoldings`; each `null` when the window holds none. For an `etf` whose `annual`/`quarterly` are both null, `notes` gains `'PERIODIC_NOT_FILED_FUND'`.
8. `coverage`: `from`/`to` = min/max `filed_date` in store for the CIK, `countInStore` = total stored rows, `recentOnly = true` when `countInStore >= 1000` or the oldest stored `filed_date` is later than `params.from` — the SEC `submissions/CIK…json` file carries only the recent window inline and the older `filings.files[]` shards are not ingested in v1 (see *Unavailable and reason codes*).
9. `ctx.page.set({ index, count: page.total, cursor: filings.length ? base64url(JSON.stringify({ acceptedAt: last.acceptedAt, accessionNo: last.accessionNo })) : null })`. PAGE FWD = older filings.
10. `notes` always includes `'FILING_FULLTEXT_UNAVAILABLE'` and `'DOCUMENT_NOT_STORED_LINK_OUT'`; `'HISTORY_LIMITED_RECENT_FILE'` when `coverage.recentOnly`.
Budget: 3 DB round-trips (instrument, filings page, form counts); zero provider calls when warm; < 200 ms p95 warm, < 3 s cold (one `submissions` fetch of ≈ 1.2 MB).

#### Live
`null` — filings are stored reference data. New filings arrive through the scheduler's `sec.submissions` job and reach an open screen only on re-run; the screen's `A` key registers a filing alert instead (`alerts.kind='filing'`, `condition: { ciks:[cik], forms, items }`, NEWS-07).

#### Screen
```
┌ CF · AAPL US Equity · Apple Inc · Filings ─────────────────────────────────────┐
│ kv#issuer  CIK 0000320193 · SIC 3571 Electronic Computers · Large accelerated   │
│            filer · FYE 09-26 · former names: — · sec.gov/cgi-bin/browse-edgar   │
│ kv#latest  latest 10-K 2025-10-31 (FY 2025-09-27) · latest 10-Q 2026-07-31      │
│            · latest 8-K 2026-08-04 (Item 8.01)                                  │
│ badges#filter [ALL · 2023-09-15..2026-09-15 · 214 filings] [XBRL only when set]  │
│ badges#notes  [FULL-TEXT SEARCH UNAVAILABLE] [LINK-OUT ONLY] [HISTORY: RECENT]   │
│ split dir 'row' sizes [0.24, 0.76]                                              │
│   table#formCounts  form | group | count | newest (date)    (left, click filters)│
│   grid#filings  filed (date, frozen) | accepted (datetime) | form | items        │
│                 | description (primaryDocDesc, elastic) | period (date)          │
│                 | XBRL (badge) | size (int, bytes) | accession (text)            │
│                 frozenColumns 1; amendments tone 'muted' with an [A] badge       │
│ footer: sources ['SEC EDGAR submissions (public domain)'] asOf=validAt knownAt=<knownAt> │
└─────────────────────────────────────────────────────────────────────────────────┘
```
Title `CF · <display> · <name> · Filings`; subtitle `<group or forms.join(",")> · <from> … <to> · <total> filings`; `initialFocus:'filings'`. Skeleton while `payload === undefined`: two muted `kv` blocks of 3 rows and `grid#filings` with 15 muted rows. `meta.unavailable` entries render in `badges#notes` with the `detail` as the badge `title`; a no-CIK issuer replaces the grid with a `text#empty` node (`tone:'warn'`) carrying the detail verbatim. `meta.entitlement` denials on the `fundamental` field class blank the grid and show the `ReasonCode` badge (`tone:'blocked'`, ENTL-05). `meta.staleness:'stale'` adds a `stale`-toned badge naming the last `captured_at` (TERM-12). `page` renders in the grid's `page: { index, count }` footer; PAGE FWD/BACK are the reserved `PageDown`/`PageUp` (§2.6).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid `filings` | `open-filing` | `ctx.openUrl(row.url)` (the primary document on sec.gov; nothing is proxied or stored) |
| `Shift+Enter` | grid `filings` | `open-fa-next` | `ctx.navigateNext(display + ' FA IS Q KNOWN=' + row.filedDate)` — the statements as of that filing (STOR-06) |
| `Enter` | table `formCounts` | `filter-form` | `ctx.setParams({ forms: [row.form], group: 'ALL' })` |
| `1`…`6` | always | `tab-group` | `ALL, PERIODIC, CURRENT, OWNERSHIP, FUND, PROXY` → `setParams({ group, forms: [] })` (number keys are the group tabs, §7.2 rule 5) |
| `X` | always | `toggle-xbrl` | `setParams({ xbrlOnly: !xbrlOnly })` |
| `I` | always | `filter-items` | `ctx.prompt('text', { label:'8-K items (comma separated)' })` → `setParams({ items })` |
| `Home` / `End` | grid | `window-back` / `window-now` | `setParams({ from: from − 3 y })` / `setParams({ from: undefined, to: undefined })` |
| `A` | always | `save-alert` | `sdk.alerts.create({ kind:'filing', condition: { ciks:[cik], forms: filter.forms, items: filter.items } })` (NEWS-07) |
| `F` | always | `open-fa` | `ctx.navigate('FA')` |
| `E` | always | `open-ee` | `ctx.navigate('EE')` |
| `C` | always | `open-cacs` | `ctx.navigate('CACS')` |
| `Delete` | always | `open-cn` | `ctx.navigate('CN')` |

#### CSV
`filename = 'CF_' + display.replace(/ /g,'_') + '_' + asOf.replace(/[-:]/g,'') + '.csv'`. The filings grid dominates, so §1.6 rule 3's "one block wide plus the others appended" form applies. Static columns: `accessionNo,form,formGroup,filedDate,acceptedAt,reportDate,items,itemLabels,primaryDoc,primaryDocDesc,isXbrl,isInlineXbrl,isAmendment,amends,sizeBytes,url`; `items`/`itemLabels` are `|`-joined. One row per `filings[]` (the current page only — the header's `# note: page 1 of 5` line states it), then the `formCounts` block appended as rows whose `accessionNo` is `_FORM_COUNT`, `form` is the form, `sizeBytes` is the count and `filedDate` is `newest`. Example: `0000320193-26-000020,10-Q,PERIODIC,2026-07-31,2026-07-31T20:31:00Z,2026-06-27,,,aapl-20260627.htm,10-Q,true,true,false,,4821004,https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm`; appended: `_FORM_COUNT,8-K,CURRENT,2026-08-04,,,,,,,,,,,17,`.

#### Help
summary `SEC filings for this issuer with form, item and XBRL filters` (59 chars); description `CF lists the SEC filings of the issuer behind the security on the command line, newest first, with the form, the 8-K items, the period of report and whether the filing carries XBRL. The number keys switch between form groups: periodic (10-K, 10-Q), current (8-K), ownership (Forms 3/4/5, 13D/G), fund (N-PORT, N-CEN) and proxy. Press X for XBRL filings only, I to filter 8-K items, Enter to open the document on sec.gov and Shift+Enter to open FA as it was known on the filing date. Documents are linked, never stored or proxied. Searching inside filing text is not possible in this build: the SEC full-text search endpoint is not reachable, so filter by form, item and date instead.`; params: `group` ("ALL, PERIODIC, CURRENT, OWNERSHIP, FUND or PROXY", example `CF PERIODIC`), `forms` ("explicit form types", `F=8-K`), `items` ("8-K item codes", `I=2.02`), `from` ("window start", `FROM=2024-01-01`), `to` ("window end", `TO=2026-01-01`), `xbrlOnly` ("XBRL filings only", `X=1`), `limit` ("rows per page, 10–200", `N=100`), `knownAt` ("point-in-time date", `KNOWN=2025-06-30`); sources `['sec.submissions', 'sec.atom']`; related `['FA', 'EE', 'CN', 'CACS', 'DES', 'HDS']`.

#### Unavailable and reason codes
`{ field:'q', reason:'NO_SOURCE', detail:'FILING_FULLTEXT_UNAVAILABLE: the SEC full-text search endpoint (efts.sec.gov) is blocked from this network, so filings cannot be searched by document text; filter by form, 8-K item and date instead (BRIEF §2)' }` — emitted on every run, which is why `CfParams` has no `q` at all ·
`{ field:'document', reason:'NOT_LICENSED', detail:'DOCUMENT_NOT_STORED_LINK_OUT: filing documents are linked on sec.gov and never stored, proxied or served by the terminal' }` — emitted on every run ·
`{ field:'coverage', reason:'NO_SOURCE', detail:'HISTORY_LIMITED_RECENT_FILE: only the recent window of data.sec.gov/submissions/CIK<cik>.json is ingested; the older filings.files[] shards are not fetched in v1, so filings before ' + coverage.from + ' are absent' }` when `coverage.recentOnly` ·
`{ field:'filings', reason:'NO_SOURCE', detail:'issuer has no SEC CIK (not an SEC filer)' }` ·
`{ field:'items', reason:'NOT_APPLICABLE', detail:'ITEMS_ONLY_ON_8K: item codes exist only on 8-K and 6-K filings; the filter matched nothing in the other selected forms' }` when `params.items` is non-empty and `forms` contains no current-report form ·
footer notes `PERIODIC_NOT_FILED_FUND` (an ETF with no 10-K/10-Q in the window) and `ITEM_LABEL_UNKNOWN` (an 8-K item code absent from `EIGHT_K_ITEMS`). Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on the `fundamental` field class blanks the grid with the reason; `PROVIDER_DOWN` (circuit open, stored rows) → `meta.staleness:'stale'`.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/CF.golden.test.ts` | AAPL (id 42) seeded from `sec-submissions-AAPL.json` at the frozen clock deep-equals `CF.issuer.json`, including `formCounts`, `latest` and `coverage.recentOnly`; SPY seeded from `sec-spy-submissions.json` asserted inline: `variant:'issuer'`, `latest.annual === null`, `latest.fundHoldings.form === 'NPORT-P'`, note `PERIODIC_NOT_FILED_FUND` |
| resolver unit | `packages/server/test/unit/functions/CF.filter.test.ts` | against the seeded fixture rows: `group:'CURRENT'` returns only 8-K/8-K/A/6-K; `items:['2.02']` keeps only filings whose `items` superset-matches; `xbrlOnly` drops Form 4s; `amends` links an `8-K/A` to the `8-K` with the same `reportDate`; `formGroup` mapping covers every form present in both submissions fixtures |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(CF.issuer.json))` equals `CF.issuer.csv`; the appended `_FORM_COUNT` rows equal `formCounts`; every `sizeBytes` cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at the frozen clock (API-05) |
| screen | `packages/web/test/screens/CF.test.tsx` | the golden renders; number keys `1`–`6` switch group via `setParams`; `X`/`I` call `setParams`; Enter calls `openUrl(row.url)`; Shift+Enter navigates to `FA IS Q KNOWN=<filedDate>`; clicking a `formCounts` row filters; the three standing `meta.unavailable` badges are present with their detail text; `payload undefined` renders the skeleton |
| paging | `packages/server/test/integration/functions/CF.page.test.ts` | `limit:10` over the 214 seeded AAPL filings: `meta.page.cursor` round-trips through `POST /functions/CF/page { direction:'fwd' }`, returns strictly older `acceptedAt`, no duplicate accession numbers, `count` stable across pages |
| point-in-time | `packages/server/test/integration/functions/CF.pit.test.ts` | `KNOWN=2025-06-30` omits every filing accepted after that instant (`accepted_at > knownAt`), so CF and FA agree about what was public on a date (STOR-06) |
| e2e | `packages/e2e/tests/export.spec.ts` (new step) | `AAPL US Equity CF PERIODIC <GO>`, `Ctrl+P` yields a CSV whose first data row's `accessionNo` and `filedDate` equal the first grid row; `PageDown` loads older filings and the page badge increments |
