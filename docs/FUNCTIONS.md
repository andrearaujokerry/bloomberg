# FUNCTIONS — function framework contract and the command line

This is the binding contract for the function framework (FUNC-01..04), the mnemonic command line
(TERM-01..03), autocomplete (TERM-02), HELP (TERM-09) and the security finder (SECF) of the terminal
clone described in [BRIEF.md](./BRIEF.md) and [REQUIREMENTS.md](./REQUIREMENTS.md). It agrees by name
with [ARCHITECTURE.md](./ARCHITECTURE.md) (module paths of §3, `ResolveContext` §5.1, manifest §5.2,
`PayloadMeta` §5.3, subjects §6.1, usage events §11), [API.md](./API.md) (`/functions/*`, `/search`,
`/universe/snapshot`, `/help/*`, `/usage/events`, CSV export §9, `Meta` §3) and
[DATA_MODEL.md](./DATA_MODEL.md) (`usage_events`, `help_tickets`, `instruments.search_weight`,
`people`, `topics`, `saved_searches`). Where the candidate designs disagreed the choice is recorded in
§9. The per-function manifests live in `FUNCTIONS_TIER1.md`, `FUNCTIONS_TIER2.md` and
`FUNCTIONS_TIER3.md`; §7 fixes the exact template those files must follow and §6 lists every code
they must cover.

Design rule (ARCHITECTURE §0): **a number exists once.** A function is a *declared screen with a data
contract* (FUNC-01): one manifest in `@terminal/core` typed by one payload type, one resolver in
`@terminal/server` that produces that payload, one screen in `@terminal/web` that renders it, and one
CSV serialiser in core that exports it. The resolver and the screen cannot drift because both are typed
by the manifest's payload type and both are checked against the same golden payload
(`fixtures/golden/functions/<CODE>.<variant>.json`).

| Item | Value |
| --- | --- |
| Manifest files | `packages/core/src/functions/manifests/<CODE>.ts` (one per catalogue code, default export `defineFunction(...)`) |
| Resolver files | `packages/server/src/functions/<CODE>/resolve.ts` (default export `FunctionServerModule`) |
| Screen files | `packages/web/src/screens/<CODE>/Screen.tsx` (named export `Screen: FunctionScreen`) |
| Generated barrels | `packages/core/src/functions/manifests/index.ts`, `packages/server/src/functions/index.ts`, `packages/web/src/screens/index.ts` — written by `scripts/gen-function-index.ts` (`npm run gen:functions`), never hand-edited |
| Golden fixtures | `fixtures/golden/functions/<CODE>.<variant>.json` (payload) and `.csv` (export), recorded in `PROVIDER_MODE=replay` at the frozen clock `2026-09-15T18:41:28Z` |
| Command grammar | `packages/core/src/command/{tokenizer,grammar,parser,rank,index,sectors}.ts`; `packages/web/src/command/{localIndex,dispatch}.ts` |
| Catalogue | 38 codes (14 Tier 1, 14 Tier 2, 10 Tier 3) plus the two catalogue aliases `IB → MSG` and `ICVS → CRVF` (§6) |
| Sections | §1 framework · §2 command line · §3 autocomplete · §4 HELP · §5 SECF · §6 catalogue · §7 template for the tier files · §8 tests · §9 decisions · §10 open questions |

---

## 1. Framework contract (FUNC-01, FUNC-02, FUNC-03, FUNC-04)

### 1.1 Vocabulary

| Term | Meaning |
| --- | --- |
| **function** | A mnemonic code (`DES`, `GP`, …) the user types. Exactly one manifest per code. |
| **manifest** | The pure declaration in core: code, aliases, tier, asset classes, zod params, argument grammar, entitlement field set, live-subject rule, CSV spec, help text, keymap. No IO, no React, no Node. |
| **resolver** | Server function `(ctx, params) → payload`. May only touch data through `ResolveContext` (§1.4). One default resolver plus optional per-asset-class variants. |
| **screen** | Client function `(props) → ScreenSpec`. Pure with respect to data: it renders the payload and declares live cells; the shell does IO, subscriptions and keyboard routing. |
| **payload** | The JSON `data` of `Payload<T>` (API.md §5.3). Every payload has a `variant: string` discriminator (§1.3). |
| **variant** | One payload shape / screen branch behind one code, selected by the instrument's asset class (FUNC-02). Functions that take no security have exactly one variant, `'default'`. |
| **result** | A cached `{ data, meta }` addressed by `meta.resultId` (ULID) for 10 minutes; the unit that PRINT exports and MSG-04 shares. |
| **launch** | One `POST /api/v1/functions/:code/run` with `launchKind:'launch'`; a `param` re-run reuses the panel frame; a `page` run follows a cursor. Each is one `usage_events` row (FUNC-04). |

### 1.2 Manifest — `packages/core/src/functions/manifest.ts`

**This file is normative for the function framework**: the manifest, `defineFunction`, `ParamGrammar`,
`LiveSpec`, `CsvColumn`/`CsvSpec`, `HelpSpec`, `KeyBinding`, `Payload`/`PayloadMeta`, the screen types
(§1.5) and `ResolveContext` (§1.4.1). ARCHITECTURE §5.1/§5.2 show earlier copies of the same
interfaces and are informative only; where they differ, this file wins. The differences are: the fields
`variants`, `aliasParams` and `payloadVersion` (additions recorded in §9), the payload bound
`T extends { variant: string }` where ARCHITECTURE has `T = unknown`, the six-value `user.role` union
and `page.set(info)` in `ResolveContext`. CONTRACTS.md lists both copies (its §3.1 and §4.1) without
ranking them — §4.1 is the one to build from.

```ts
import { z } from 'zod';
import type { AssetClass } from '../types/instrument';
import type { FieldId } from '../types/fields';

export type Tier = 1 | 2 | 3;
export type FunctionCategory =
  | 'reference' | 'pricing' | 'charting' | 'news' | 'fundamentals' | 'screening'
  | 'rates' | 'derivatives' | 'portfolio' | 'messaging' | 'monitor' | 'system';

/** Types a command-line argument can be coerced to (§2.4 fixes the accepted syntaxes). */
export type ArgType =
  | 'tenor' | 'range' | 'date' | 'datetime' | 'number' | 'int' | 'enum' | 'string'
  | 'security' | 'topic' | 'watchlist' | 'index' | 'currency' | 'curve' | 'boolean';

/** Maps the tokens after the function code onto `params` (§2.4). */
export interface ParamGrammar {
  positional: ReadonlyArray<{ name: string; type: ArgType; values?: readonly string[]; optional?: boolean }>;
  keyed?: Readonly<Record<string, { name: string; type: ArgType; values?: readonly string[] }>>;   // 'ADJ=TR' → params.adjust
  rest?: { name: string; type: 'text' };                                                            // 'N tender offer' → params.query
}

/** What the screen subscribes to once the payload is on screen (ARCHITECTURE §6.1 subjects). */
export interface LiveSpec {
  subjects: string[];                 // 'q:42', 'b1m:42', 'oc:42', 'c:UST_PAR', 'r:SOFR', 'e:CPIAUCSL', 'n:inst:42', 'room:7'
  fields: FieldId[] | '*';            // '*' = the subject's whole field set (API.md §6.1)
  conflationMs?: number;              // per-screen override of hello.conflationMs (50..5000)
  essential?: string[];               // subjects that must never be shed (default: all subjects of a kv/header block)
}

export interface CsvColumn { id: string; label: string; type: 'string' | 'number' | 'date' | 'datetime' | 'boolean'; decimals?: number }
export interface CsvDocument {
  filename: string;                   // 'HP_AAPL_US_Equity_20260915T184128Z.csv' (API.md §9)
  attribution: string[];              // licence_registry.attribution of every cited source, in provenance idx order
  asOf: string;                       // meta.asOf.validAt
  columns: CsvColumn[];
  rows: Array<Array<string | number | boolean | null>>;   // one table; multi-block screens use a leading `section` column (§1.6)
}
export interface CsvSpec<P, T> {
  filename(params: P, ctx: { display: string | null; asOf: string }): string;
  columns: CsvColumn[] | ((params: P, payload: T) => CsvColumn[]);   // a function when columns depend on the payload (QM, W, HP fields)
  rows(payload: T, params: P): CsvDocument['rows'];
}

export interface HelpSpec {
  summary: string;                                                   // one line, ≤ 80 chars, shown in autocomplete and HELP index
  description: string;                                               // HELP ×1 body; plain text with blank-line paragraphs
  params: Array<{ name: string; text: string; example?: string }>;   // one per params key, same order as the zod object
  keys: Array<{ key: string; action: string }>;                       // derived from keymap when omitted; may add explanations
  sources: string[];                                                 // licence_registry.source_id values the function cites
  related: string[];                                                 // function codes offered as next steps
}

export interface KeyBinding {
  key: string;                        // 'G', 'Shift+ArrowUp', 'Ctrl+Enter', '1'..'9' (KeyboardEvent.code-based; §2.6 lists reserved keys)
  action: string;                     // stable action id the screen switches on: 'open-gp', 'cycle-adjust', 'page-fwd'
  when?: 'grid' | 'chart' | 'form' | 'always';   // focus region the binding is active in (default 'always')
  description: string;                // shown in HELP and the footer key bar
}

export interface FunctionManifest<P extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>, T extends { variant: string } = { variant: string }> {
  code: string;                       // canonical mnemonic, uppercase, 1–6 [A-Z0-9], unique across codes AND aliases
  name: string;                       // 'Security Description'
  aliases: readonly string[];         // 'IB' → MSG; never equal to another code/alias
  aliasParams?: Readonly<Record<string, Record<string, unknown>>>;   // params merged BEFORE zod parse when launched by that alias: ICVS → { curveId:'SOFR_OIS' }
  tier: Tier;
  category: FunctionCategory;
  assetClasses: readonly AssetClass[] | 'any' | 'none';   // 'none' = takes no security (WEI, TOP, ECO, HELP); 'any' = optional security (N)
  requiresSecurity: boolean;          // true → 422 NO_SECURITY_CONTEXT / client NO_SECURITY_LOADED without one; false with 'any' = security optional
  variants: Readonly<Partial<Record<AssetClass, string>>>;   // asset class → payload.variant ('etf' → 'equity'); {} for 'none' (variant 'default')
  params: P;                          // zod object; EVERY optional key has .default(); no transforms that change types
  paramGrammar: ParamGrammar;
  fieldIds: (assetClass: AssetClass | null) => FieldId[];   // entitlement pre-check set for the runner (ARCHITECTURE §10); null for 'none'
  pageable: boolean;                  // PAGE FWD/BACK semantics; resolver must honour ctx.page
  live: ((params: z.infer<P>, payload: T) => LiveSpec | null) | null;   // null = static screen
  csv: CsvSpec<z.infer<P>, T>;
  help: HelpSpec;
  keymap: readonly KeyBinding[];
  screenKind: 'declarative' | 'custom';   // custom = the ScreenSpec contains a 'custom' node that owns a canvas (GP, GIP, GC, CRVF, OMON smile)
  payloadVersion: number;             // bumped on any breaking change of T (API.md §11); part of registryVersion
  _payload?: T;                       // phantom for typing only; never set
}

export const defineFunction = <P extends z.ZodObject<z.ZodRawShape>, T extends { variant: string }>(m: FunctionManifest<P, T>) => m;
export type ParamsOf<M> = M extends FunctionManifest<infer P, any> ? z.infer<P> : never;
export type PayloadOf<M> = M extends FunctionManifest<any, infer T> ? T : never;
```

Manifest invariants, enforced by `packages/core/test/functions/manifests.test.ts` over every manifest in
the generated barrel:

1. `code` matches `/^[A-Z][A-Z0-9]{0,5}$/`; codes and aliases are globally unique (case-insensitive).
2. `params.parse({})` succeeds (every key has a default) and `z.toJSONSchema(params)` succeeds (it is
   served as `FunctionManifestPublic.paramsSchema`).
3. Every `paramGrammar` name and every `help.params[].name` is a key of `params`; every `keymap[].key`
   is outside the reserved set of §2.6; `aliasParams` keys are in `aliases`.
4. `assetClasses === 'none'` ⇒ `variants` is `{}` and `requiresSecurity === false`; otherwise every listed
   asset class has a `variants` entry, and `fieldIds(ac)` returns only ids present in
   `core/fields/dictionary.ts`.
5. `csv.columns` (when static) ids are unique; `csv.rows` of the golden payload has exactly that many
   cells per row.
6. `help.sources` ⊆ seeded `licence_registry.source_id` values (`packages/server/src/providers/licences.ts`).

### 1.3 Payload conventions — `packages/core/src/types/function.ts`

```ts
import type { FieldId, FieldValue } from './fields';
import type { Tier, ValueState } from './quote';
import type { ReasonCode } from './entitlement';

export type UnavailableReason = 'NO_SOURCE' | 'NOT_LICENSED' | 'NOT_APPLICABLE';

/** API.md §3 Meta plus resultId — identical on REST, cached result and CSV header (ARCHITECTURE §5.3). */
export interface PayloadMeta {
  traceId: string; resultId: string;
  asOf: { validAt: string; knownAt: string };
  tier: Tier; staleness: ValueState;
  provenance: Array<{ idx: number; sourceId: string; provenanceId: number; capturedAt: string; sourceTs: string | null; attribution: string; requestKey?: string }>;
  entitlement: Array<{ fieldId: FieldId; decision: 'downgrade' | 'deny'; effectiveTier: Tier | null; reason: ReasonCode }>;
  unavailable: Array<{ field: string; reason: UnavailableReason; detail: string }>;
  engines: Array<{ name: string; version: string; inputsHash: string }>;
  adjustments?: Array<{ beforeDate: string; priceFactor: number; volumeFactor: number; kind: 'split' | 'dividend' | 'capital_return' }>;
  page?: { index: number; count: number; cursor: string | null };
  servedAt: string;
  quota?: { dataPointsCharged: number; uniqueInstrumentsAdded: number };
}
export interface Payload<T> { data: T; meta: PayloadMeta }

/** A value the screen may render as a number: carries its own staleness, reason and provenance (TERM-12, DATA-10, ENTL-05).
 *  `v === null` ⇒ blank; `r` says why. `live` lets the shell overwrite `v` from the WS cache. */
export interface ValueCell {
  v: FieldValue;                       // number | string | boolean | null
  st: ValueState;                      // 'live'|'stale'|'closed'|'blank'|'na'
  r?: ReasonCode;                      // when v === null
  ts?: number | null;                  // source timestamp epoch ms (FEED-05 'src')
  provIdx: number;                     // index into meta.provenance
  live?: { subject: string; field: FieldId };
}

/** Every function payload extends this. */
export interface BasePayload { variant: string }
```

Rules for payload types (checked by review against §7 and by the golden tests):

1. `variant` is the first key. Functions with `assetClasses:'none'` use `'default'`.
2. Any value that comes from the plant or a provider and is shown as a number is a `ValueCell`, never a
   bare `number`. Stored reference/fundamental values that are not live may be bare numbers **only**
   inside a block that carries a `provIdx` for the whole block.
3. Timestamps are ISO-8601 UTC strings (`2026-09-15T18:41:28Z`) and dates `YYYY-MM-DD`, the REST
   convention (API.md); epoch ms appear only inside `ValueCell.ts` and chart series arrays.
4. Numbers are unformatted (full stored precision, ≤ 15 significant digits); formatting is a screen and
   CSV concern through `core/fields/format.ts`.
5. Nothing in a payload is a function or a class instance; `JSON.parse(JSON.stringify(p))` deep-equals `p`.
6. Unavailable data is `null` in the payload **and** a `meta.unavailable[]` entry (EE estimates, ECO
   consensus, WB non-US tenors) — never a fabricated number (NEWS-08 spirit, BRIEF §2).

### 1.4 Server side — `packages/server/src/functions/`

#### 1.4.1 `context.ts` — `ResolveContext` (verbatim ARCHITECTURE §5.1 plus `page.set`)

```ts
import type { Clock } from '@terminal/core';
import type { AssetClass, Instrument, FieldId, QuoteState, Tier, ValueState, EntitlementDecision, UsageType } from '@terminal/core';

export interface ResolveContext {
  user: { userId: number; firmId: number; sessionId: string; role: 'user' | 'admin' | 'compliance' | 'dataops' | 'helpdesk' | 'newsroom' };
  traceId: string;                                     // UUID v4 from x-trace-id (ARCHITECTURE §11)
  panelId?: string;                                    // 'p1'..'p8'
  instrument: Instrument | null;                       // resolved as-of ctx.asOf; null when the manifest takes no security
  asOf: { validAt: Date; knownAt: Date };              // defaults now/now; export/page/share re-supply the cached meta.asOf
  clock: Clock;                                        // the only source of "now" (VirtualClock in tests)
  db: Db;                                              // Drizzle, request transaction with app.user_id / app.firm_id set (RLS)
  data: DataServices;                                  // §1.4.2 — the only readers a resolver may use
  plant: PlantReader;                                  // §1.4.2 — entitlement-filtered composite snapshots
  providers: ReadThrough;                              // §1.4.2 — freshness guarantee, never a raw adapter call
  entitle: (fieldIds: FieldId[], usage: UsageType, tier?: Tier) => Promise<EntitlementDecision>;   // extra checks beyond the runner's pre-check
  prov: ProvenanceCollector;                           // every value block cites one idx (DATA-10)
  unavailable: UnavailableCollector;                   // meta.unavailable
  engines: EngineCollector;                            // meta.engines (ANAL-08)
  usage: UsageType;                                    // 'display' | 'export' | 'api'
  page?: { cursor: string | null; direction: 'fwd' | 'back'; set(info: { index: number; count: number; cursor: string | null }): void };
}
export type FunctionResolver<P, T> = (ctx: ResolveContext, params: P) => Promise<T>;
export interface FunctionServerModule<P, T> {
  resolve: FunctionResolver<P, T>;                                      // default / dispatcher
  variants?: Partial<Record<AssetClass, FunctionResolver<P, T>>>;       // keyed by asset class (FUNC-02); 'etf' may point at the equity resolver
}
```

#### 1.4.2 Collaborators the resolver sees (`packages/server/src/functions/context.ts` exports these too)

```ts
export interface ProvenanceCollector {
  /** Register a provenance row; returns its idx. Same provenanceId → same idx. `st`/`tier` feed meta.staleness (worst) and meta.tier (lowest). */
  add(ref: { sourceId: string; provenanceId: number; capturedAt: Date; sourceTs: Date | null; st?: ValueState; tier?: Tier }): number;
  /** Cite a plant snapshot: uses state.prov and state.st/tier. */
  addQuote(state: QuoteState): number;
  list(): PayloadMeta['provenance'];                   // attribution filled from licenceRegistry by the runner
  worstState(): ValueState; lowestTier(): Tier;
}
export interface UnavailableCollector { add(n: { field: string; reason: UnavailableReason; detail: string }): void; list(): PayloadMeta['unavailable'] }
export interface EngineCollector      { add(e: { name: string; version: string; inputsHash: string }): void; list(): PayloadMeta['engines'] }

export interface PlantReader {
  subjectFor(instrumentId: number, kind?: 'q' | 'b1m' | 'oc'): string;                 // 'q:42'
  snapshot(subject: string): QuoteState | undefined;                                  // policyTier.view applied for ctx.user's granted tier; denied fields null
  snapshotMany(subjects: string[]): Map<string, QuoteState>;
  ensureHot(subjects: string[]): void;                                                // adds to hotset (ARCHITECTURE §6.2); never blocks
}
export type ReadThroughKind =
  | 'sec.submissions' | 'sec.companyfacts' | 'sec.nport' | 'cboe.quote' | 'cboe.options' | 'yahoo.intraday' | 'yahoo.daily'
  | 'yahoo.fx' | 'coingecko.simple' | 'fred.series' | 'nyfed.rates' | 'finra.shortInterest' | 'bbg.rss' | 'fed.rss';
export interface ReadThrough {
  /** Guarantees the store is at most maxAgeMs old for (kind, key): returns immediately when fresh, otherwise fetches through the
   *  provider adapter (token buckets shared with the scheduler, PROVIDER_MODE honoured) and persists. Resolvers then read via ctx.data.
   *  Throws ProviderUnavailableError (503 PROVIDER_UNAVAILABLE) when the circuit is open and nothing is stored; returns { fresh:false }
   *  with the stored provenance when the circuit is open but stale data exists (the resolver marks cells 'stale'). */
  ensure(kind: ReadThroughKind, key: string, opts: { maxAgeMs: number }): Promise<{ fresh: boolean; provenanceId: number | null; capturedAt: Date | null }>;
}

/** Data services (ARCHITECTURE §3.3 data/*). Signatures below are the subset every function manifest depends on; WP-04 owns the
 *  implementation, WP-10 may not add readers elsewhere. All reads are as-of ctx.asOf unless stated. */
export interface DataServices {
  reference: {
    instrument(id: number): Promise<InstrumentDetail>;                                              // instrument+issue+issuer+listings+mdLines+identifiers+terms+classifications
    resolve(ref: SecurityRefInput, opts?: { panelSecurityId?: number }): Promise<ResolveItem>;
    search(q: z.infer<typeof SecfParams> & { cursor?: string }): Promise<{ hits: SecfPayload['hits']; total: number; facets: SecfPayload['facets']; nextCursor: string | null }>;   // §5
    members(indexInstrumentId: number, asOfDate?: string): Promise<MembersResponse>;
    calendar(calendarId: string): Promise<Calendar>;
  };
  historical: { bars(id: number, q: { start: string; end?: string; periodicity: 'D'|'W'|'M'|'Q'|'Y'; adjust: AdjustPolicy; currency?: string; fields?: FieldId[] }): Promise<SeriesBlock & { adjustments: PayloadMeta['adjustments'] }> };
  intraday:   { bars(id: number, q: { days: 1|2|5; interval: '1m'|'5m'; session: 'regular'|'extended' }): Promise<SeriesBlock & { sessions: Array<{ start: string; end: string; kind: 'pre'|'regular'|'post' }> }> };
  ticks:      { last(id: number, n: number): Promise<TickRow[]> };
  snapshot:   { fields(ids: number[], fields: FieldId[]): Promise<Map<number, Record<FieldId, ValueCell>>> };   // plant + reference merge, entitlement-filtered
  fundamentals: {
    facts(cik: string, concepts: string[], periods: PeriodSpec, knownAt: Date): Promise<XbrlFact[]>;         // knownAt REQUIRED (STOR-06)
    statements(cik: string, q: { statement: 'IS'|'BS'|'CF'|'RATIOS'|'PER_SHARE'; periodType: 'Q'|'FY'|'TTM'; periods: number; knownAt: Date }): Promise<FinStatement>;
    frames(concept: string, period: string): Promise<Map<string, number>>;                                    // cik → value (EQS)
  };
  econ:   { series(code: string): Promise<EconSeries>; observations(code: string, q: { from?: string; to?: string; knownAt: Date }): Promise<EconObs[]>; calendar(q: { from: string; to: string; country: 'US'|'ALL' }): Promise<EconEvent[]>; fomc(): Promise<FomcMeeting[]> };
  rates:  { latest(code: string): Promise<RateFixing>; history(code: string, days: number): Promise<RateFixing[]> };
  curves: { points(curveId: string, date?: string): Promise<CurvePoints>; build(curveId: string, date: string, interpolation?: string): Promise<CurveBuild> };   // build cached in curve_builds by inputsHash
  options:{ chain(underlyingId: number, expiry?: string): Promise<ChainSnapshot>; terms(contractId: number): Promise<OptionTerms> };
  news:   { search(q: NewsQuery): Promise<{ items: NewsItem[]; nextCursor: string | null; total: number }>; top(scope: 'all'|'instrument'|'topic'|'feed', id?: string, limit?: number): Promise<NewsItem[]>; topics(): Promise<Topic[]> };
  filings:{ list(cik: string, q: { forms?: string[]; from?: string; to?: string; cursor?: string; limit: number }): Promise<{ items: Filing[]; nextCursor: string | null; total: number }> };
  holdings:{ holders(id: number, asOfDate?: string): Promise<HoldersResponse>; etfHoldings(etfId: number, asOfDate?: string): Promise<EtfHolding[]> };
  portfolio:{ get(id: number): Promise<Portfolio>; positions(id: number, asOfDate?: string): Promise<Position[]>; recon(id: number): Promise<ImportReport> };   // RLS-scoped
  workspace:{ watchlist(id: number | 'default'): Promise<Watchlist>; watchlists(): Promise<Watchlist[]> };
  messaging:{ rooms(): Promise<Room[]>; messages(roomId: number, q: { cursor?: string; limit: number }): Promise<{ items: Message[]; nextCursor: string | null }>; directory(q: string): Promise<DirectoryEntry[]> };
}
```

Every `DataServices` method runs after the runner's entitlement pre-check and refuses to be constructed
without an `EntitlementDecision` (`server/test/unit/entitlement.guard.test.ts`, ARCHITECTURE §10).

#### 1.4.3 `runner.ts` — `runFunction(code, body, http)` (ARCHITECTURE §5, API.md §5.3)

```
 1. manifest = registry.get(code)                       → 404 FUNCTION_NOT_FOUND
    alias = the typed code when it differs from manifest.code; params0 = { ...manifest.aliasParams?.[alias], ...body.params }
 2. params = manifest.params.parse(params0)             → 400 VALIDATION_FAILED { location:'fnParams', grammar: manifest.paramGrammar }
 3. security: if manifest.assetClasses === 'none' → instrument = null (body.security ignored)
              else if body.security absent: manifest.requiresSecurity → 422 NO_SECURITY_CONTEXT; else instrument = null
              else instrument = SecurityResolver.resolve(body.security, asOf)   → 404 SECURITY_NOT_FOUND | 409 AMBIGUOUS_SECURITY | 422 NOT_IN_UNIVERSE
 4. applicability: assetClasses is a list and instrument.assetClass ∉ list → 422 FUNCTION_NOT_APPLICABLE { assetClass, applicable }
 5. decision = evaluate({ user, firm, instrumentId, assetClass, fieldIds: manifest.fieldIds(assetClass), tier:'delayed',
                          usage: session.kind === 'api' ? 'api' : 'display', purpose: manifest.code, traceId })
    every field denied → 403 ENTITLEMENT_DENIED; else continue with decision.downgrades in meta.entitlement
 6. ctx = buildContext({ …, instrument, asOf, page: body.page })   (one request transaction; app.user_id/app.firm_id set)
    resolver = module.variants?.[instrument.assetClass] ?? module.resolve
 7. data = await resolver(ctx, params)      (timeout 20 s → 503 PROVIDER_UNAVAILABLE when the cause is a provider; else 500 INTERNAL)
    assert data.variant === (instrument ? manifest.variants[instrument.assetClass] : 'default')   (dev/test: throws; prod: logs)
 8. meta = { traceId, resultId: ulid(clock), asOf: ctx.asOf (ISO), tier: prov.lowestTier(), staleness: prov.worstState(),
             provenance: prov.list() with attribution from licenceRegistry, entitlement: decision.downgrades,
             unavailable: unavailable.list(), engines: engines.list(), page: ctx.page?.info, servedAt: clock.now() }
 9. resultCache.put(resultId, { code: manifest.code, alias, params, security: instrument?.instrumentId ?? null, data, meta, userId })   (LRU 500/user, 10 min)
10. accessLog.enqueue(decision.rows); usageEvents.enqueue({ kind: body.launchKind === 'param' ? 'fn.param' : body.page ? 'fn.page' : 'fn.launch',
             userId, firmId, sessionId, panelId: body.panelId, code: manifest.code, paramsHash: sha256(canonicalJson(params)),
             instrumentId, durationMs, traceId, details: { alias, variant: data.variant, launchKind: body.launchKind } })
11. metrics fn_resolve_ms{code}.observe; reply 200 { data, meta }
```

`canonicalJson` = JSON with object keys sorted recursively, no whitespace (`packages/core/src/functions/hash.ts`).
Reproducibility (ANAL-08): with an explicit `asOf`, steps 6–8 are pure in `(code, params, asOf,
store)`; only `traceId`, `resultId`, `servedAt`, `staleness` and live-subject `capturedAt` may differ
between two runs. `server/test/parity/fn-parity.test.ts` asserts this for every manifest.

`POST /functions/:code/page { resultId, direction }` re-runs steps 6–11 with the cached `params`,
`security`, `asOf` and `page = { cursor: cached.meta.page.cursor, direction }`; the new result gets a new
`resultId`. `GET /results/:resultId` returns the cached result to its producer, or re-runs it at the cached
`asOf` under the viewer's entitlements (MSG-04).

#### 1.4.4 `resultCache.ts` and `export.ts`

```ts
export interface CachedResult { resultId: string; userId: number; code: string; alias?: string; params: unknown; security: number | null; data: unknown; meta: PayloadMeta; storedAt: number }
export class ResultCache { put(r: CachedResult): void; get(resultId: string, userId: number): CachedResult | undefined /* undefined when expired or another user */; }
```

`export.ts#csvForFunction(code, args, http)`:

```
1. cached = args.resultId ? resultCache.get(resultId, user) : undefined
   miss with resultId only → 404 RESULT_EXPIRED unless args.params+validAt+knownAt are also supplied
2. if !cached: re-run steps 2–8 of the runner with asOf = { validAt, knownAt } and usage:'export'; regenerated = true
3. decision = evaluate({ …, fieldIds: manifest.fieldIds(assetClass), usage:'export', purpose:'export:'+code })
   ANY denied field → 403 ENTITLEMENT_DENIED { reasons }  (a subset is never exported — API.md §9)
4. doc = toCsv(manifest, cached.data, cached.params, { display, asOf: meta.asOf.validAt, attribution })   (§1.6)
5. text = writeCsv(doc, headerLines(meta, regenerated))
6. usageEvents.enqueue({ kind:'fn.export', code, paramsHash, instrumentId, details: { rows: doc.rows.length, regenerated } }); accessLog.enqueue(decision.rows); quota charge rows × columns
7. 200 text/csv with the headers of API.md §9; content-disposition filename = doc.filename
```

### 1.5 Client side — `packages/web/src/screen/types.ts`

```tsx
import type { PayloadMeta, ValueCell, FieldId, FieldValue, ValueState, ReasonCode, InstrumentSummary } from '@terminal/sdk';
import type { KeyBinding, CsvColumn } from '@terminal/core';

export interface LiveView {
  /** Latest value for a (subject, field) from the SDK QuoteCache, or the payload cell when no delta has arrived. Recomputed staleness every 1 s. */
  get(subject: string, field: FieldId): ValueCell;
  state(subject: string): ValueState;                    // subject-level verdict (status frames 'shed'/'gone' → 'blank')
}
export interface ScreenCtx<P> {
  panelId: string;                                       // 'p1'..'p8'
  setParams(patch: Partial<P>): void;                    // → re-run with launchKind:'param' (usage fn.param), keeps the frame
  navigate(command: string): void;                       // executes a command line string in THIS panel ('AAPL US Equity GP 1Y')
  navigateNext(command: string): void;                   // same, in the next panel (Shift+Enter conventions)
  export(): void;                                        // PRINT → sdk.fn.csvUrl({ resultId }) (never serialises locally)
  page(direction: 'fwd' | 'back'): void;                 // → POST /functions/:code/page
  focus(nodeId: string): void;                           // move keyboard focus to a node id in the ScreenSpec
  prompt(kind: 'security' | 'date' | 'text' | 'field' | 'watchlist', opts?: { label?: string; initial?: string }): Promise<string | null>;   // modal typeahead prompt
  provenance(provIdx: number): void;                     // opens the provenance panel (Ctrl+I)
  openUrl(url: string): void;                            // external link (SEC, Bloomberg RSS) in a new tab
}
export interface ScreenProps<P, T> {
  payload: T | undefined;                                // undefined while loading → the screen returns its skeleton spec
  params: P;
  instrument: InstrumentSummary | null;
  meta: PayloadMeta | undefined;
  live: LiveView;
  error?: { code: string; message: string; traceId: string };   // last run error for this frame (rendered by the shell footer; screens may add context)
  ctx: ScreenCtx<P>;
}
export type FunctionScreen<P, T> = (props: ScreenProps<P, T>) => ScreenSpec;

export interface ScreenSpec {
  title: string;                                         // 'DES · AAPL US Equity · Apple Inc'
  subtitle?: string;
  body: Node;
  footer?: { sources: string[]; asOf?: string; notes?: string[] };   // attribution strip (licence_registry.attribution), knownAt for PIT screens
  keymap?: KeyBinding[];                                 // additions to manifest.keymap (dynamic, e.g. per tab)
  initialFocus?: string;                                 // node id
}

export type Node =
  | { kind: 'split'; dir: 'row' | 'col'; sizes: number[]; children: Node[] }                        // sizes are fractions summing to 1
  | { kind: 'kv'; id: string; title?: string; columns?: 1 | 2 | 3; rows: Array<{ label: string; value: Cell; provIdx?: number; fieldId?: FieldId }> }
  | { kind: 'grid'; id: string; columns: GridColumn[]; rows: GridRow[]; live?: { subjectOf: (row: GridRow) => string | null };
      sort?: { col: string; dir: 'asc' | 'desc' }; groupBy?: string; frozenColumns?: number; selectable?: boolean;
      onEnter?: (row: GridRow) => string | null; onShiftEnter?: (row: GridRow) => string | null;                 // command strings
      emptyText?: string; page?: { index: number; count: number } }
  | { kind: 'table'; id: string; columns: CsvColumn[]; rows: Cell[][]; caption?: string }               // small static table
  | { kind: 'chart'; id: string; spec: ChartSpec }
  | { kind: 'tabs'; id: string; tabs: Array<{ id: string; label: string; key?: string; body: Node }>; active: string; onChange?: (id: string) => void }
  | { kind: 'form'; id: string; fields: FormField[]; submitLabel?: string; onSubmit: (values: Record<string, unknown>) => void }
  | { kind: 'text'; id: string; text: string; mono?: boolean; tone?: 'normal' | 'muted' | 'warn' | 'error' }
  | { kind: 'list'; id: string; items: Array<{ id: string; primary: string; secondary?: string; ts?: string; badges?: Badge[]; command?: string; url?: string }>; live?: { subject: string } }
  | { kind: 'badges'; id: string; items: Badge[] }
  | { kind: 'custom'; id: string; component: 'PriceChart' | 'CurveChart' | 'OptionSurface' | 'Sparkline' | 'Composer'; props: unknown };

export interface Cell extends ValueCell { fmt?: 'px' | 'pct' | 'bp' | 'int' | 'ccy' | 'date' | 'datetime' | 'text' | 'shares'; decimals?: number; dir?: 'up' | 'down' | 'flat'; fieldId?: FieldId; command?: string }
export interface GridColumn { id: string; label: string; fieldId?: FieldId; width?: number; align?: 'left' | 'right'; fmt?: Cell['fmt']; decimals?: number; sortable?: boolean; live?: boolean }
export interface GridRow { id: string; cells: Record<string, Cell>; group?: string; subject?: string; instrumentId?: number; command?: string; tone?: 'normal' | 'muted' | 'highlight' }
export interface FormField { id: string; label: string; type: 'text' | 'number' | 'date' | 'enum' | 'security' | 'boolean' | 'field'; value: unknown; values?: readonly string[]; step?: number; bigStep?: number; unit?: string; readonly?: boolean }
export interface Badge { text: string; tone: 'info' | 'ok' | 'warn' | 'error' | 'stale' | 'blocked'; title?: string }
```

`ChartSpec` (`packages/web/src/chart/spec.ts`, consumed by `web/chart/ChartCanvas.tsx`; WP-13 implements
against this shape):

```ts
export type SeriesType = 'line' | 'area' | 'mountain' | 'candle' | 'ohlc' | 'bar' | 'step' | 'scatter' | 'tick' | 'pnf' | 'profile' | 'heatmap';   // CHRT-01
export interface ChartSeries {
  id: string; label: string; type: SeriesType; pane: string; yAxis: string;
  x: Float64Array | number[];                            // epoch ms (time axis), days (tenor axis) or category index
  y: Float64Array | number[];                            // close/level; NaN = gap
  ohlc?: { o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array }; volume?: Float64Array;
  provIdx: number; currency?: string; calendarId?: string;
  live?: { subject: string; field: FieldId; mode: 'append-forming-bar' | 'replace-last' };   // CHRT-02 streaming without full re-render
  style?: { color?: 'auto' | 'up' | 'down' | 'neutral' | `#${string}`; width?: number; dashed?: boolean };
}
export interface ChartSpec {
  kind: 'price' | 'intraday' | 'curve' | 'surface' | 'sparkline' | 'bar';
  xAxis: { type: 'time' | 'tenor' | 'category'; tz?: string; calendarId?: string; categories?: string[]; sessions?: Array<{ start: number; end: number; kind: 'pre' | 'regular' | 'post' }> };
  yAxes: Array<{ id: string; side: 'left' | 'right'; scale: 'linear' | 'log'; fmt: Cell['fmt']; decimals?: number; normalise?: 'none' | 'pct' | 'base100' }>;   // CHRT-03 independent axes
  panes: Array<{ id: string; height: number /* fraction */; title?: string }>;
  series: ChartSeries[];
  studies?: Array<{ id: string; params: Record<string, number>; pane: string; inputSeriesId: string }>;   // computed client-side in chart/studies (CHRT-04)
  events?: Array<{ t: number; kind: 'earnings' | 'dividend' | 'split' | 'news' | 'filing' | 'index_add' | 'index_drop' | 'fomc'; label: string; command: string; provIdx: number }>;   // CHRT-06 click-through
  annotations?: Array<{ annotationId: number | null; kind: 'trendline' | 'hline' | 'vline' | 'fib' | 'text' | 'regression_channel' | 'rect'; anchors: Array<{ t: number; v: number }>; label?: string; editable: boolean }>;   // CHRT-05
  reference?: Array<{ yAxis: string; v: number; label: string }>;   // prev close, par rate, strike
  crosshair: boolean; range?: [number, number]; logScale?: boolean;
  onEvent?: (e: { kind: 'event' | 'annotation-save' | 'crosshair'; payload: unknown }) => void;
}
```

Shell contract for every screen (`packages/web/src/screen/ScreenRenderer.tsx`): every node is keyboard
operable (TERM-06): `Tab`/`Shift+Tab` move between nodes in document order; arrows move within a grid,
list, tabs or form; `Enter` on a grid/list row executes its `command`; `Space` toggles a boolean form
field; a `custom` node receives focus and its own key handling through `props.keymap`. `Cell.live`
cells are registered with `web/grid/cellRegistry` so plant deltas overwrite `v`, `st`, `ts` and flash
without a React render (ARCHITECTURE §6.6). Every `Cell` is rendered by `core/fields/format.ts` with
`fmt`/`decimals`/`fieldId`; `st` selects the colour and the `·` stale glyph; `v === null` renders `—`
with `r` as tooltip (TERM-12, ENTL-05). `Ctrl+I` on any focused cell opens the provenance panel for
`provIdx`.

### 1.6 CSV exporter — `packages/core/src/functions/csv.ts`

```ts
export interface CsvContext { display: string | null; asOf: string; attribution: string[] }
export function toCsv<P, T>(manifest: FunctionManifest<any, T>, payload: T, params: P, ctx: CsvContext): CsvDocument;
export function writeCsv(doc: CsvDocument, headerLines: string[]): string;   // RFC 4180, CRLF, UTF-8 no BOM, '#' comment lines first (API.md §9)
```

Rules (FUNC-03, API-05):

1. `toCsv` is the **only** serialiser. The server export route calls it on the cached payload; the web
   client never serialises (`web/export/csv.ts` navigates to `sdk.fn.csvUrl`); tests call it on golden payloads.
2. Cells are emitted at full precision: numbers as shortest round-trip decimal (`Number.prototype.toString`,
   never exponent for |x| ≥ 1e-6), dates `YYYY-MM-DD`, datetimes ISO UTC, booleans `true`/`false`, `null` → empty.
   `ValueCell` contributes `v` only; a blank cell with a reason is empty — the reason is in the header
   `# entitlement:` line, and any *denied* field aborts the export before `toCsv` runs (§1.4.4).
3. One table per document. Screens with several blocks (DES kv + filings + news, YAS results +
   cashflows, BTMM) export in long format with a leading `section` column (`section,key,value,unit,asOf,source`)
   or, when one block dominates, that block wide plus the others as `section`-prefixed rows appended
   after it. The template (§7) fixes which per function.
4. `columns` may depend on the payload (`QM`, `W`, `HP`) — then `FunctionManifestPublic.csvColumns` is `null`.
5. Header lines, in order: `# terminal-export v1`, `# function: <CODE> [alias: <ALIAS>]  security: <display|->  params: <canonicalJson>`,
   `# asOf: validAt=… knownAt=…  tier: …  staleness: …`, `# source: <attribution>; …`,
   `# provenance: <ids>  engines: <name/version,…>  trace: <traceId>  regenerated: <bool>`,
   then optional `# entitlement: <fieldId>=<reason>,…` and `# unavailable: <field>=<reason>,…`.
6. `packages/core/test/functions/csv.test.ts` proves `writeCsv(toCsv(golden.json)) === golden.csv` for every
   `<CODE>.<variant>` pair, and that every numeric cell equals the payload value it came from (parity).

### 1.7 Registry — construction on every side

```ts
// packages/core/src/functions/registry.ts
export class FunctionRegistry {
  constructor(manifests: readonly FunctionManifest[]);            // throws on duplicate code/alias
  readonly version: string;                                       // sha1 of sorted `${code}@${payloadVersion}` — the registryVersion of /status and the /functions ETag
  get(codeOrAlias: string): FunctionManifest | undefined;         // case-insensitive; aliases resolve
  canonical(codeOrAlias: string): string | undefined;             // 'ib' → 'MSG'
  all(): FunctionManifest[];                                      // catalogue order (tier, then §6 order)
  byTier(t: Tier): FunctionManifest[];
  applicable(assetClass: AssetClass | null): FunctionManifest[];  // null → 'none' | 'any' only
  isFunctionToken(token: string): boolean;                        // exact code/alias match, case-insensitive (parser §2.3)
  codes(): string[];                                              // codes + aliases, for the autocomplete index
}
// packages/core/src/functions/manifests/index.ts  (GENERATED)
export const manifests = { DES, GP, /* … every file in this directory … */ } as const;
export type FunctionCode = keyof typeof manifests;                // 'DES' | 'GP' | …  (canonical codes only)
export type PayloadOf<C extends FunctionCode> = import('../manifest').PayloadOf<(typeof manifests)[C]>;
export type ParamsOf<C extends FunctionCode> = import('../manifest').ParamsOf<(typeof manifests)[C]>;
export const registry = new FunctionRegistry(Object.values(manifests));
```

| Side | File | Content |
| --- | --- | --- |
| core | `functions/manifests/index.ts` (generated) | the `manifests` object and `registry` above |
| sdk | `packages/sdk/src/functions/index.ts` | `export { registry, manifests } from '@terminal/core'; export type { FunctionCode, PayloadOf, ParamsOf }; runFunction()` validates params locally with `manifest.params` before the request (API.md §10.3) |
| server | `packages/server/src/functions/index.ts` (generated) | `export const modules: Record<FunctionCode, FunctionServerModule<any, any>>` importing every `<CODE>/resolve.ts` |
| web | `packages/web/src/screens/index.ts` (generated) | `export const screens: Record<FunctionCode, () => Promise<{ Screen: FunctionScreen<any, any> }>>` — lazy `import()` per screen so a Tier-3 screen is not in the first bundle |
| server startup | `index.ts` step 4 (ARCHITECTURE §12.1) | asserts `Object.keys(modules)` equals `registry.all().map(m => m.code)`; exit 1 otherwise |
| server route | `GET /functions` | `FunctionManifestPublic[]` derived by `toPublic(manifest)` (`z.toJSONSchema(params)`, `fieldIds` evaluated per listed asset class, `csvColumns` null when a function) |

`scripts/gen-function-index.ts` globs the three directories, sorts by code, writes the three barrels, and
fails (`exit 1`) when a manifest has no resolver directory, no screen file, or no golden pair; when a
resolver or screen exists with no manifest; or when `manifest.variants` values are not all present as
golden files. It runs in `npm run build`, `npm test` and the pre-commit hook.

### 1.8 Adding a function (FUNC-01)

Function 39 costs exactly this, and nothing else in the repository changes:

1. `packages/core/src/functions/manifests/<CODE>.ts` — `defineFunction({...})` with the `Params` zod
   object and the exported `<Code>Payload` type (template §7).
2. `packages/server/src/functions/<CODE>/resolve.ts` — `export default { resolve, variants } satisfies FunctionServerModule<Params, Payload>`.
3. `packages/web/src/screens/<CODE>/Screen.tsx` — `export const Screen: FunctionScreen<Params, Payload>`.
4. `fixtures/golden/functions/<CODE>.<variant>.json` + `.csv` for every variant, generated by
   `npm run golden:functions -- <CODE>` in replay mode at the frozen clock, and reviewed in the PR.
5. `npm run gen:functions` (regenerates the three barrels; CI fails if they are stale).
6. If the payload cites a field id not yet in `core/fields/dictionary.ts`: add the `FieldDef` and its
   `field_licence` seed row (`providers/licences.ts`); startup validates both (ARCHITECTURE §12.1).
7. One entry in the matching `FUNCTIONS_TIER<n>.md` following §7, and the requirement rows in `TRACEABILITY.md`.

Autocomplete, HELP, `/functions`, the SDK's `FunctionCode` union, the parity test, the replay
function-output matrix (ARCHITECTURE §8.2) and the usage roadmap pick the new code up from the barrel.

### 1.9 Polymorphism by asset class (FUNC-02)

- `manifest.assetClasses` says where the code is applicable; `manifest.variants` maps each applicable
  asset class to a payload variant key; the server module's `variants[assetClass]` picks the resolver;
  `payload.variant` is asserted by the runner (§1.4.3 step 7) and switched on by the screen.
- Several asset classes may share a variant (`etf → 'equity'` for DES/HP/GP; `index → 'index'`); a
  variant may be served by the default resolver when the difference is data-only.
- Screens are one file per code with one branch per variant (`switch (payload.variant)`), sharing
  widgets; a variant may be a separate component file under `screens/<CODE>/` when it exceeds ~300 lines.
- Goldens, help (`GET /functions/:code/help?assetClass=`), `fieldIds(assetClass)` and CSV columns are all
  per variant. `DES` on `AAPL US Equity`, `SPX Index`, `EURUSD Curncy`, `912797VE4 Govt`,
  `AAPL 9/16/26 C245 Equity`, `SOFR Index`, `CPIAUCSL Index` and `BTC Crypto` is eight payload shapes
  (`equity`, `index`, `fx`, `govt`, `option`, `rate`, `econ`, `crypto`) behind one code.
- A function launched on an asset class it does not list is refused server-side with
  `422 FUNCTION_NOT_APPLICABLE` and never reaches a resolver; the autocomplete ranks such functions down
  (−20, §3.3) so the user sees it before GO.

### 1.10 Usage instrumentation (FUNC-04)

Every launch, parameter change, page, export and help press is one row in `usage_events`
(DATA_MODEL §14; columns `ts, user_id, firm_id, session_id, panel_id, kind, code, params_hash,
instrument_id, duration_ms, trace_id, details`). Kinds are the closed set of API.md §5.13.

| Kind | Emitted by | `code` | `details` | Notes |
| --- | --- | --- | --- | --- |
| `fn.launch` | server runner (authoritative); client adds `durationMs` = GO → first paint via `POST /usage/events` (`details.clientReported=true`) | canonical | `{ alias?, variant, launchKind:'launch' }` | one per GO that starts a new frame |
| `fn.param` | server runner when `launchKind:'param'` | canonical | `{ changed: string[] /* param names */, variant }` | `ScreenCtx.setParams`, key-driven cycles (`A`, `P`, `T` …), form submits |
| `fn.page` | server runner via `/functions/:code/page` | canonical | `{ direction, index }` | PAGE FWD/BACK |
| `fn.export` | server export route | canonical | `{ rows, columns, regenerated }` | PRINT, `/data/csv` is `details.route='data.csv'` |
| `fn.help` | client (`HelpOverlay`) | code shown | `{ mode:'function'\|'search'\|'index', assetClass? }` | HELP ×1 |
| `ticket.open` | server `POST /help/tickets` | function of the panel | `{ ticketId }` | HELP ×2 |
| `search.select` | client autocomplete on GO/selection | function code when the hit is a function | `{ kind, rank, queryLen, latencyMs, source:'local'\|'server' }` | never the query text |
| `cmd.parse_error` | client, sampled 1 in 20 | — | `{ shape, problems: string[], head: raw.slice(0,32) }` | never more than 32 chars of input |
| `panel.switch` | client | — | `{ from, to }` | |
| `ws.subscribe`, `ws.slow`, `ws.resync` | server ws/session | — | `{ subjects, effectiveMs }` | |

Mechanics: `packages/web/src/state/usage.ts` buffers client events and flushes through
`sdk.usage.events()` every 5 s, at 100 events, and on `pagehide` (`navigator.sendBeacon` fallback);
`packages/server/src/observability/usageEvents.ts` batches inserts every 1 s or 500 rows, never on the
response path. `params_hash = sha256(canonicalJson(params))` so a param change is countable without
storing free text; `details` never contains a raw command line, a message body or a portfolio value.
The roadmap query is `GET /api/v1/usage/functions?days=30` (`code, launches, users, exports`) and the SQL
in ARCHITECTURE §11.

---

## 2. The command line (TERM-01, TERM-03)

### 2.1 Grammar — `packages/core/src/command/grammar.ts`

```
command      := ws* (shell | help | body) ws*
shell        := '/' shellword (ws+ token)*                 ; §2.6; never reaches the function parser
help         := 'HELP' (ws+ (CODE | text))?                ; §4
body         := security (ws+ function_part)?               ; security-only  → TERM-03 reload current function
              | function_part                               ; function-only  → TERM-03 apply to current security
              | ε
function_part:= CODE (ws+ args)?
security     := ticker_key | identifier | formula
ticker_key   := ticker_tokens (ws+ exch)? (ws+ sector)?     ; 'AAPL', 'AAPL US', 'AAPL US Equity', 'T 4.25 08/15/36 Govt', 'AAPL 9/16/26 C245 Equity'
ticker_tokens:= token (ws+ token){0,4}                      ; ≤ 5 tokens (Treasury 'T 4.25 08/15/36', option 'AAPL 9/16/26 C245')
exch         := [A-Z]{2}                                    ; OpenFIGI composite exchange code ('US', 'LN', 'GR'); only meaningful with sector Equity
sector       := 'Equity'|'Index'|'Curncy'|'Govt'|'Corp'|'Comdty'|'Mtge'|'Muni'|'Pfd'|'M-Mkt'|'Crypto'   ; case-insensitive; unique prefix ≥ 3 chars; aliases §2.2
identifier   := '/' scheme '/' value                        ; '/isin/US0378331005' '/figi/BBG000B9XRY4' '/cusip/037833100' '/occ/AAPL260916C00245000' '/series/fred.csv/DGS10'
              | bare_id                                     ; FIGI 'BBG000B9XRY4', ISIN 'US0378331005', CUSIP '912797VE4', OCC 'AAPL260916C00245000' — recognised by shape AND check digit
formula      := '<' formula_text '>'                        ; canonical: '<RATIO(AAPL US Equity, SPX Index)> GP'
              | FNAME '(' balanced ')'                      ; bare form accepted when tokens[0] matches /^[A-Z]+\(/ and the parens balance
CODE         := [A-Z][A-Z0-9]{0,5}                          ; registry code or alias
args         := arg (ws+ arg)*
arg          := KEY '=' value | value                       ; interpreted by manifest.paramGrammar (§2.4)
token        := [^ \t]+
```

Market sector → asset classes (`packages/core/src/command/sectors.ts`):

| Sector | Asset classes | Yellow key | Notes |
| --- | --- | --- | --- |
| `Equity` | `equity`, `etf`, `option` | F8 | option contracts use the Bloomberg-style `AAPL 9/16/26 C245 Equity` form |
| `Index` | `index`, `rate`, `econ` | F10 | `SPX Index`, `SOFR Index`, `CPIAUCSL Index` (API.md §3 examples) |
| `Curncy` | `fx` | F11 | `EURUSD Curncy`; alias `Currency` |
| `Govt` | `govt` | F2 | `912797VE4 Govt`, `T 4.25 08/15/36 Govt` |
| `M-Mkt` | `rate` | F5 | `SOFR M-Mkt` resolves to the same instrument as `SOFR Index`; display form is `Index`; alias `MMKT` |
| `Crypto` | `crypto` | — | `BTC Crypto` |
| `Corp`, `Comdty`, `Mtge`, `Muni`, `Pfd` | — | F3, F9, F4, F6, F7 | parsed (so the grammar is complete) → `NOT_IN_UNIVERSE` problem; server answers `422 NOT_IN_UNIVERSE` |

### 2.2 Tokenizer — `packages/core/src/command/tokenizer.ts`

```ts
export interface Token { text: string; upper: string; start: number; end: number }
export function tokenize(raw: string): Token[];
```

1. Split on runs of spaces/tabs; keep `[start, end)` spans into `raw`; `upper = text.toUpperCase()`.
2. A `<…>` formula is one token from `<` to the matching `>` (whitespace inside preserved). A bare
   `NAME(` … `)` formula is one token from the name to the balancing `)`.
3. `KEY=VALUE` stays one token; a quoted value `KEY="two words"` is one token with quotes stripped.
4. Ticker normalisation happens in `core/ids/securityRef.ts`, not here: `BRK/B`, `BRK.B` and `BRK-B` are
   accepted and canonicalised to the master's `BRK/B`; the tokenizer never rewrites text.
5. Input is case-insensitive except free text (`rest` arguments, quoted values) which keeps the raw case.

### 2.3 Parser — `packages/core/src/command/parser.ts`

```ts
import type { SecurityRef, MarketSector, AssetClass } from '../types/instrument';
export type CommandShape = 'empty' | 'shell' | 'help' | 'security' | 'function' | 'security+function' | 'invalid';
export interface CommandProblem { code: 'UNKNOWN_FUNCTION' | 'UNKNOWN_SECTOR' | 'NOT_IN_UNIVERSE' | 'BAD_IDENTIFIER' | 'ARG_PARSE' | 'AMBIGUOUS' | 'NO_SECURITY_LOADED' | 'NOT_APPLICABLE'; span: [number, number]; message: string }
export interface CommandSecurity {
  text: string;                                          // canonical display text as typed, sector appended when inferred ('AAPL US Equity')
  span: [number, number];
  sectorGiven: boolean;
  ref: SecurityRef | { kind: 'formula'; value: string };
  instrumentId?: number;                                 // known when the ticker matched the local index exactly (client) — sent as { id }
  assetClass?: AssetClass;                               // from the local index when known
}
export interface ParsedCommand {
  raw: string; shape: CommandShape;
  security?: CommandSecurity;
  fn?: { code: string; alias?: string; span: [number, number] };   // canonical code; alias = what was typed when different
  args: string[]; argSpan?: [number, number];
  params?: Record<string, unknown>;                       // output of parseArgs (§2.4); undefined for shape 'security'
  shell?: { word: string; args: string[] };
  help?: { code?: string; query?: string };
  problems: CommandProblem[];
}
export interface PanelContext { security: { instrumentId: number; assetClass: AssetClass; marketSector: MarketSector; display: string } | null; fn: string | null; params: Record<string, unknown> }
export interface ParseEnv {
  registry: FunctionRegistry;
  panel: PanelContext;
  /** Longest-prefix ticker lookup against the local universe index (client) or the master (server). Returns the instrumentId(s) whose
   *  ticker equals tokens.join(' ') (case-insensitive), optionally narrowed by exchCode/sector; [] when unknown. */
  lookupTicker(tokens: string[], opts?: { exchCode?: string; sector?: MarketSector }): Array<{ instrumentId: number; assetClass: AssetClass; marketSector: MarketSector; display: string }>;
}
export function parse(raw: string, env: ParseEnv): ParsedCommand[];   // ranked interpretations, best first; never throws
export function toRunRequest(cmd: ParsedCommand, env: ParseEnv): { code: string; alias?: string; body: FunctionRunRequestInput } | { problem: CommandProblem };
```

Algorithm (deterministic, no IO; `packages/core/test/command/parser.test.ts` and
`parser.fuzz.test.ts` — QA-05 — cover every step):

1. `tokens = tokenize(raw)`; empty → `[{ shape:'empty' }]`.
2. `raw` starts with `/` and does **not** match `^/(isin|figi|cusip|sedol|occ|series)/` → `shape:'shell'`
   (§2.6). Otherwise a leading `/scheme/value` token is an identifier (step 4).
3. `tokens[0].upper === 'HELP'` → `shape:'help'` with `code` when `tokens[1]` is a registry code/alias, else
   `query = raw after HELP` (§4).
4. **Anchors**, tried in this order; the first that succeeds fixes `security` and `rest`:
   - *Sector anchor*: the last index `k ≤ 5` whose token is a sector name, its unique ≥ 3-char prefix, or a
     sector alias. `security = tokens[0..k]` (`exch` = `tokens[k-1]` when it is two letters and `k ≥ 2` and
     the sector is `Equity`); `rest = tokens[k+1..]`. Sectors outside the wedge add `NOT_IN_UNIVERSE`.
   - *Identifier anchor*: `tokens[0]` is `/scheme/value`, or matches a bare shape **and** its check digit
     (`core/ids/{figi,isin,cusip,occ}.ts`). A shape match with a failing check digit adds `BAD_IDENTIFIER` and
     falls through. `rest = tokens[1..]`.
   - *Formula anchor*: `tokens[0]` is a formula token → `ref = { kind:'formula' }`; `rest = tokens[1..]`.
5. If an anchor was found: `rest[0]` must be a function token (`registry.isFunctionToken`), else if `rest`
   is non-empty the parse gets `UNKNOWN_FUNCTION` on `rest[0]` **and** a second interpretation with
   `shape:'security'` (the security alone) is returned after it. With a function: `args = rest[1..]`,
   `params = parseArgs(...)`; `shape = 'security+function'`.
6. No anchor — generate up to three interpretations:
   - **F** (function-first): `registry.isFunctionToken(tokens[0])` → `fn = tokens[0]`, `args = tokens[1..]`, `shape:'function'`.
   - **S** (security without sector): for `j` from `min(4, tokens.length-1)` down to `0`,
     `env.lookupTicker(tokens[0..j])`; the longest `j` with hits wins. If `tokens[j+1]` exists it must be a
     function token (else the interpretation is dropped); `args = tokens[j+2..]`. Sector is inferred from
     the hit (`display` carries it); multiple hits across sectors produce one interpretation per hit,
     ordered by §3.3 (Equity first).
   - **S+F unknown**: nothing matched locally and `tokens.length ≥ 1` → `shape:'security'` with
     `ref = { kind:'ticker', value: tokens[0..j] }` unresolved (server `/ref/resolve` decides; the autocomplete
     shows Yahoo fallback hits), plus `UNKNOWN_FUNCTION` when a second token exists and is not a function.
7. Interpretations are ordered by the ranking rules of §3.3 applied to their leading candidate, with the
   hard rule R0: an exact function code/alias that is applicable in the panel context sorts first.
   `parse()[0]` is what GO executes; the rest appear as alternatives in the autocomplete list.
8. Args → `params` by `parseArgs(manifest.paramGrammar, args, env)` (§2.4). Unknown or malformed args add
   `ARG_PARSE` problems and are ignored: the function still launches with defaults and the footer shows
   the problem text.

`toRunRequest` applies the TERM-03 rules (§2.5) and produces `{ code, body: { security, params, panelId,
launchKind:'launch' } }` where `security` is `{ id }` when `instrumentId` is known, `{ ref: text }` for an
unresolved ticker/identifier, `{ formula }` for a formula. The server re-parses `ref` with
`core/ids/securityRef.ts`, so the client and the API accept the same strings (API.md §3).

### 2.4 Argument mapping — `packages/core/src/command/args.ts`

```ts
export function parseArgs(grammar: ParamGrammar, args: string[], env: ParseEnv): { params: Record<string, unknown>; problems: CommandProblem[] };
```

1. Tokens of the form `KEY=VALUE` (key case-insensitive, must be in `grammar.keyed`) are keyed args and are
   removed first. An unknown key → `ARG_PARSE`.
2. Remaining tokens fill `grammar.positional` in order. A token that fails the type of the current slot is
   tried against the next *optional* slot (so `HP W` fills `periodicity`, skipping the optional `range`);
   a required slot with no token → `ARG_PARSE`.
3. Leftover tokens: if `grammar.rest` exists they are joined with single spaces (raw case, quotes
   stripped) into `rest.name`; else `ARG_PARSE` on the first leftover.
4. Coercion by `ArgType`:

| ArgType | Accepted syntax | Value |
| --- | --- | --- |
| `tenor` | `^\d+[DWMY]$` (`10D`, `13W`, `6M`, `10Y`) | uppercase string |
| `range` | `1D 5D 1M 3M 6M YTD 1Y 2Y 5Y 10Y MAX` | uppercase string; a tenor is accepted when the manifest's enum lists it |
| `date` | `YYYY-MM-DD`, `M/D/YY`, `M/D/YYYY`, `DDMMMYY`, `DDMMMYYYY`, `TODAY`, `T-<n>` (business days via NYSE calendar) | `YYYY-MM-DD` |
| `datetime` | date forms above plus `T HH:MM` (`2026-09-15T14:30`, ET assumed) | ISO UTC |
| `number` / `int` | JS numeric literal, optional `%`/`bp` suffix (`4.25`, `50bp` → `0.005`, `10%` → `0.1`), `_`/`,` thousands separators | number (int rejects fractions) |
| `enum` | case-insensitive unique prefix of `values` (`ADJ=TR` → `total_return` when values include it and a manifest-declared short alias map) | the canonical value |
| `boolean` | `1 0 Y N YES NO TRUE FALSE ON OFF` | boolean |
| `string` | any token | as typed |
| `security` | a ticker key with sector, an identifier, or a bare ticker resolved by `env.lookupTicker` | `SecurityRefInput` |
| `topic` | topic code from the snapshot (`MARKETS`, `FED`) | uppercase code |
| `watchlist` | watchlist name (case-insensitive) or numeric id | `{ id }` or `{ name }` |
| `index` | index code (`SPX`, `NDX`) resolved to its `Index` instrument | `{ id }` |
| `currency` | ISO 4217 (`USD`) | uppercase |
| `curve` | `curves.curve_id` (`UST_PAR`, `SOFR_OIS`) | uppercase |

### 2.5 Context rules (TERM-03) — `packages/web/src/command/dispatch.ts`

| Parse shape | Panel has security | Panel empty |
| --- | --- | --- |
| `function` | run `fn` on `panel.security` (unless `assetClasses:'none'`, which ignores it) | `requiresSecurity` → footer `NO SECURITY LOADED`, autocomplete offers `SECF <typed text>`; otherwise run `fn` with no security |
| `security` | run `panel.fn` (with `panel.params`) on the new security; if `panel.fn` is not applicable to the new asset class → `DES` | run `DES` |
| `security+function` | both replaced; `params` from args merged over manifest defaults (never over the panel's previous params) | same |
| `help` | §4 | §4 |
| `shell` | §2.6 | §2.6 |

Every executed command pushes `Frame { security, fn, params, resultId:null, scroll:0 }` on the panel's
`frameStack` (API.md §5.7 `PanelState`), truncating any forward history, appends the raw text to
`history` (≤ 100) and clears `commandDraft`. The frame's `traceId` is minted client-side
(`crypto.randomUUID()`) and used for the run request and the `fn.launch` event. A `param` change
replaces the frame's `params` and `resultId` in place (no new frame); a `page` run likewise. The
workspace autosaves the panel state 2 s after the last change (TERM-05).

### 2.6 Shell commands and reserved keys (TERM-06, TERM-07)

Shell commands (leading `/`, never reaching the function parser): `/layout 1|2h|2v|4`, `/panel 1..8`
(focus), `/conflate <ms>`, `/theme dark|light|system`, `/clear` (empties the panel's frame stack),
`/logout`, `/trace` (shows the last trace id), `/version`. They emit `panel.switch` where relevant and
are listed in `HELP` under "Shell".

Reserved global keys (`packages/web/src/keyboard/keymap.ts`); function keymaps may not bind them:

| Key | Action | Semantics |
| --- | --- | --- |
| `Enter` | **GO** | execute `parse(text)[0]` or the selected autocomplete row; inside a grid/list/form the node's own Enter applies first when the command line is empty |
| `Escape` | **CANCEL / MENU** | priority: close overlay → close autocomplete → clear command draft → (nothing to cancel) pop the frame stack one step (MENU = back to the previous screen) |
| `F1` | **HELP** | §4; second press within 10 s → ticket |
| `F2`…`F11` | yellow sector keys | insert the sector token (`Govt`, `Corp`, `Mtge`, `M-Mkt`, `Muni`, `Pfd`, `Equity`, `Comdty`, `Index`, `Curncy`) after the typed ticker; `keydown.preventDefault()` for F5/F11 where the browser permits, and always on the on-screen key bar |
| `Ctrl+P` | **PRINT** | export the focused panel's result as CSV (§1.6) |
| `PageDown` / `PageUp` | **PAGE FWD / PAGE BACK** | pageable functions page; non-pageable screens scroll one viewport |
| `Alt+ArrowLeft` / `Alt+ArrowRight` | frame back / forward | walks `frameStack` (`index`) |
| `Alt+1`…`Alt+8` | focus panel | `panel.switch` usage event |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | next / previous panel | |
| `Tab` / `Shift+Tab` | next / previous focus region | command line → screen nodes in document order → key bar |
| `Ctrl+I` | provenance | provenance panel for the focused cell (DATA-10) |
| `Ctrl+L` | command line | focus the panel's command line (typing anywhere already routes printable keys there unless focus is in a form field or the MSG composer) |
| `Ctrl+E` | export data of the focused grid as `/data/csv` | for screens where PRINT is a long-format document |

Function keymaps may use: letters, digits, `ArrowUp/Down/Left/Right`, `Home`, `End`, `Insert`,
`Delete`, `+`, `-`, `/`, `Space`, with `Shift` and `Ctrl` modifiers except the combinations above, and
`Alt+<letter>`. Keys are matched on `KeyboardEvent.code` so macOS `Alt` dead keys do not matter.

### 2.7 Worked examples

| Input (panel state) | `parse()[0]` | Executed | Alternatives shown |
| --- | --- | --- | --- |
| `AAPL` (empty panel) | S: `AAPL US Equity`, no function | `DES` on AAPL | `APLE US Equity` (name word "Apple Hospitality"), `AAPX US Equity` |
| `AAPL` (panel: MSFT / GP {range:'5Y'}) | S | `GP {range:'5Y'}` on AAPL (TERM-03: security-only keeps the panel's function and params) | `APLE US Equity`, `AAPX US Equity` |
| `AAPL US` | S, exch given | `DES` (or panel fn) on AAPL US | — |
| `AAPL US Equity` | sector anchor | `DES` / panel fn | — |
| `aapl equity gp 1y` | sector anchor + F | `GP { range:'1Y' }` on AAPL US Equity | — |
| `GP` (panel: AAPL) | F | `GP` on AAPL | `GPC US Equity` (ticker prefix) |
| `GP` (empty panel) | F with `NO_SECURITY_LOADED` | footer error; row 2 is `SECF GP` | `GPC US Equity` |
| `GP 5Y TYPE=CANDLE ADJ=TR` | F + args | `GP { range:'5Y', type:'candle', adjust:'total_return' }` | — |
| `W` (any) | R0: function `W` | Watchlists | `W US Equity` (Wayfair) as row 2 |
| `W US Equity` | sector anchor | `DES` on Wayfair | — |
| `CF` (panel: AAPL) | R0: `CF` Company Filings (applicable to equity) | filings for AAPL | `CF US Equity` (CF Industries) |
| `CF` (panel: EURUSD Curncy) | `CF` not applicable to fx (−20) → `CF US Equity` first | `DES` on CF Industries | `CF` (dimmed, "not applicable to Curncy") |
| `SPX` | S: `SPX Index` | `DES` / panel fn | `SPXL US Equity`, `SPXS US Equity` |
| `EURUSD` | S: `EURUSD Curncy` | `DES` | — |
| `SOFR` | S: `SOFR Index` | `DES` (rate variant) | `SOFR M-Mkt` (same instrument, listed once) |
| `T 4.25 08/15/36 Govt YAS` | sector anchor (k=3) + F | `YAS` on the 10Y note | — |
| `T 4.25 08/15/36` | S with j=2 (`lookupTicker` on the 3-token ticker) | `DES` / panel fn | `T US Equity` (AT&T) as row 2 |
| `912797VE4 Govt` | sector anchor (CUSIP token) | `DES` govt variant | — |
| `912797VE4` | identifier anchor (CUSIP check digit ok) | `DES` | — |
| `BBG000B9XRY4 HP 2020-01-01 2020-12-31 W` | identifier anchor (FIGI) + F + args | `HP { start, end, periodicity:'W' }` | — |
| `/isin/US0378331005 DES` | identifier anchor (scheme form) | `DES` on AAPL | — |
| `/panel 3` | shell | focus panel 3 | — |
| `AAPL 9/16/26 C245 Equity OVML` | sector anchor (k=3, option form) + F | `OVML` on the contract | — |
| `<RATIO(AAPL US Equity, SPX Index)> GP` | formula anchor + F | `GP` on the formula series (CHRT-07) | — |
| `N tender offer` | R0: `N` is always applicable; F + rest | `N { query:'tender offer' }` | `NTES US Equity` (ticker prefix) as row 2 |
| `NI FED` | F + positional topic | `NI { topic:'FED' }` | — |
| `TOP` | F | Top news | `TOPS US Equity` |
| `QM MAG7` | F + positional watchlist | `QM { source:{ kind:'watchlist', name:'MAG7' } }` | — |
| `MEMB SPX` | F + positional index | `MEMB { index:{ id: <SPX> } }` | — |
| `ECO` | F | `ECO { country:'US' }` | — |
| `HELP YAS` | help | help overlay for YAS | — |
| `HELP duration` | help | search over manifests and the field dictionary | — |
| `IB` | F alias → `MSG` | messaging | `IBM US Equity` (prefix) |
| `ICVS` | F alias → `CRVF` with `aliasParams { curveId:'SOFR_OIS' }` | SOFR OIS curve | — |
| `IBM Corp` | sector anchor, sector outside wedge | footer `NOT_IN_UNIVERSE: Corp is not covered in v1` | `IBM US Equity` |
| `XYZQ` (unknown) | unresolved S | server `/ref/resolve` → `SECURITY_NOT_FOUND`; footer shows candidates | Yahoo fallback hits (−25, marked) |
| `YAS` (panel: AAPL) | F, `NOT_APPLICABLE` problem | not sent; footer `YAS applies to Govt` | `YAS` dimmed; `SRCH` suggested via `help.related` |

---

## 3. Autocomplete (TERM-02)

### 3.1 Universe snapshot and the local index

The client ranks locally against a `UniverseIndex` built from `GET /api/v1/universe/snapshot`
(API.md §5.2: tuples `[instrumentId, ticker, sector, exchCode, name, assetClass, searchWeight, status]`,
`[code, name, aliases, tier]`, `[personId, name, roleFirm]`, `[code, name]`). Contents (seed volumes,
DATA_MODEL §18): ≈ 36 k US-listed instruments, 31 indices, 9 FX pairs, 4 crypto, 20 govt/rate
instruments, ≈ 70 econ series, 38 functions + aliases, ≈ 60–500 people, 13 topics. **Option contracts
are not in the snapshot** (3.5 k per underlying); they are reached through OMON or by typing the OCC /
`AAPL 9/16/26 C245 Equity` form, which the server resolves.

`packages/web/src/command/localIndex.ts` fetches with `If-None-Match`, stores the snapshot in
IndexedDB (`terminal.universe`, key = `version`), builds the index in a Worker (< 300 ms for 45 k rows)
and swaps it in atomically; until then the shell uses the server `/search` for every keystroke. MRU
(`terminal.mru`, ≤ 50 `{ kind, id, lastUsed, count }`) lives in `localStorage` and is rebuilt from
`panels[].history` of the workspace on a fresh machine (TERM-05).

`packages/core/src/command/index.ts`:

| Structure | Purpose | Build | Lookup |
| --- | --- | --- | --- |
| `entries: Entry[]` | flat array of every candidate (`kind, id, primary, upperTicker/upperCode, nameWords, sector, assetClass, weight, status`) | O(n) | by index |
| `tickerSorted: Uint32Array` | indexes into `entries` sorted by `upperTicker` | sort, O(n log n) | binary search lower/upper bound on a prefix: O(log n + hits) |
| `codeSorted: Uint32Array` | function codes and aliases sorted | tiny | binary search |
| `wordIndex: Map<string, Uint32Array>` | 3-char prefix of every name word → entries (`'APP'` → Apple Inc, Apple Hospitality…) | O(words) | `get(prefix3)` then filter on the full prefix |
| `trigrams: Map<string, Uint32Array>` | trigram → entries, built only for entries with `weight ≥ 2` (index members) or `kind ≠ 'instrument'` (≈ 700 entries) | O(m) | union of the query's trigram postings, Jaccard scored; used only when prefix hits < 5 and `len(q) ≥ 3` |
| `identifierSorted` | FIGI/ISIN/CUSIP are **not** in the snapshot; exact identifiers go to `/ref/resolve` | — | — |
| `mru: Map<string /* kind:id */, { rank: number; count: number }>` | recency boost | ≤ 50 | O(1) |

Memory: ≈ 45 k entries × ~120 bytes ≈ 6 MB including strings; typed arrays ≈ 400 KB.

### 3.2 Candidate model — `packages/core/src/search/types.ts`

```ts
export interface Candidate {
  kind: 'instrument' | 'function' | 'person' | 'topic';
  id: string;                                            // instrumentId | function code | personId | topic code
  primary: string;                                       // 'AAPL US Equity' | 'GP' | 'Jane Doe (Demo Capital)' | 'FED'
  secondary: string;                                     // 'Apple Inc · Common Stock · US' | 'Price graph' | 'CFO · Apple Inc' | 'Federal Reserve'
  assetClass?: AssetClass; marketSector?: MarketSector;
  score: number;
  matchedOn: 'code' | 'ticker' | 'name' | 'isin' | 'cusip' | 'figi' | 'alias' | 'trigram';
  matched: Array<[number, number]>;                      // highlight ranges in primary
  insertText: string;                                    // what GO executes for this row: 'AAPL US Equity' | 'GP' | 'MSG jane.doe' | 'NI FED'
  source: 'local' | 'yahoo';
  applicable?: boolean;                                  // functions: applicable in the panel context (rendered dimmed when false)
}
export interface RankContext {
  panel: PanelContext; hasPanelSecurity: boolean;
  watchlistIds: Set<number>;                             // instruments in the focused panel's watchlist/monitor rows
  mru: Map<string, { rank: number; count: number }>;
  sectorGiven?: MarketSector;                            // R1 filter
  kinds?: Array<Candidate['kind']>;                      // SECF passes ['instrument']
}
export function rank(query: string, index: UniverseIndex, ctx: RankContext, registry: FunctionRegistry): Candidate[];   // ≤ 12, best first
```

The same `Candidate` is `SearchHit` on the wire (API.md §5.2) and `rank()` is the same function on the
server (`server/src/search/rank.ts`), so local and server orderings are identical.

### 3.3 Ranking algorithm — `packages/core/src/command/rank.ts`

Only the token being completed is scored (`q`, upper-cased); anchored tokens narrow the candidate set.

```
Hard rules (applied before scoring):
  R0  q equals a function code or alias exactly (case-insensitive) and the function is applicable in ctx
      (assetClasses 'none' | 'any' | panel.security.assetClass ∈ assetClasses | (panel empty ∧ !requiresSecurity))
      → that function is row 0. (Typing 'W' opens Watchlists; 'W US Equity' or picking row 2 opens Wayfair.)
  R1  a sector was typed → only instruments whose assetClass ∈ sectorAssetClasses(sector); functions/people/topics excluded.
  R2  ctx.kinds given → only those kinds.
  R3  q shorter than 2 chars → topics and people excluded; q shorter than 1 → empty list.

score(c) = match + kindPrior + popularity + recency + context − penalties

match:      function code exact 100 · alias exact 92 · code/alias prefix 80 − 2·(len(code) − len(q)), floor 62
            ticker exact 100 · ticker prefix 80 − 2·(len(ticker) − len(q)), floor 60
            name first-word prefix 60 · name other-word prefix 50
            person name word prefix 50 · topic code prefix 60 · topic name word prefix 45
            trigram Jaccard s ∈ [0.4, 1] → 40·s   (only when prefix hits < 5 and len(q) ≥ 3)
            none → excluded
kindPrior:  function  +12 if applicable in ctx; −20 if the panel has a security of a non-listed class; −4 if the panel is empty and requiresSecurity
            instrument 0 · person −8 · topic −6
popularity: instrument min(10, 5·searchWeight)   (searchWeight 1.0 default → 5; S&P members 2.0 → 10; Cboe-only 0.5 → 2.5)
            function  tier 1 → 6 · tier 2 → 3 · tier 3 → 0
            person/topic 0
recency:    +15·(1 − rank/20) for the 20 most recent MRU entries (rank 0 = most recent), else 0; +1 per 10 uses, max +5
context:    +8 instrument in ctx.watchlistIds
            +4 same issuer as the panel security (ETF ↔ index proxy, share classes)
            sector default when no sector typed and ticker matched: Equity +4 · Index +3 · Curncy +2 · Govt +2 · Crypto +1
penalties:  status ≠ active −30 · source 'yahoo' −25 (and never above a local hit with match ≥ 60)
tie-break:  shorter primary, then primary alphabetical, then kind order instrument < function < topic < person
```

Result assembly: sort, take the top 12; at most 8 of one kind unless the other kinds are empty; the
first row is exactly `parse(text)[0]`'s leading candidate (the parser and the ranker share this
function, so GO never executes something other than row 0). Rows render `primary` with `matched`
highlighted, `secondary`, a kind glyph, tier badge for functions, `applicable:false` dimmed with the
reason, and `source:'yahoo'` with a "not in master" badge.

### 3.4 Server fallback — `GET /api/v1/search`

Called only when (a) the local index is not yet built, or (b) `len(q) ≥ 3`, no local hit has
`match ≥ 60`, and 60 ms have elapsed without a further keystroke (debounce). The server runs
`search/rank.ts` over its snapshot plus `pg_trgm` on `instruments.name`, `people.name` and
`issuer_aliases`, then, when still fewer than 3 hits, the Yahoo `v1/finance/search` adapter
(`yahoo.search`, 1 req/s bucket, replay fixture `yahoo-search`) marked `source:'yahoo'`. Yahoo hits are
never written to the master (API.md §5.2). Responses arriving after a newer keystroke are discarded
(`AbortController` per query). Server hits are merged into the local list under the same scoring, so
the list never reorders on arrival except by appending below local rows.

### 3.5 Budget and measurement (NFR: autocomplete < 80 ms p95, keystroke < 16 ms)

| Stage | Budget | Measured by |
| --- | --- | --- |
| tokenize + parse + rank on 45 k entries | ≤ 4 ms p95 | `packages/core/test/command/command.bench.ts` (vitest bench, fails > 8 ms on CI hardware) |
| autocomplete render (≤ 12 memoised rows, one frame) | ≤ 16 ms | `packages/web/test/autocomplete.frame.test.tsx` (jsdom timing) and `packages/e2e/tests/autocomplete.spec.ts` (Performance API marks `ac:start`/`ac:paint`) |
| server `/search` | < 80 ms p95 end-to-end | `StatusResponse.timings.autocompleteP95Ms` fed by `search.select` events' `latencyMs`; `search_local_hit_ratio` metric ≥ 0.95 |
| index build | < 300 ms in a Worker, never on the main thread | `localIndex.test.ts` |

Because the local path needs no network, the 80 ms budget holds for ≥ 95 % of keystrokes by
construction; the remainder are the server fallbacks, which are bounded by the debounce plus route p95.

---

## 4. HELP (TERM-09)

| Press | Behaviour | Emits |
| --- | --- | --- |
| `F1` once, or `HELP <GO>` with a function loaded | `HelpOverlay` over the right third of the focused panel: `GET /api/v1/functions/:code/help?assetClass=` → summary, description, params with examples and current values, keys (manifest keymap + screen keymap), the field definitions of every `fieldId` on screen (API-07), sources with `licence_registry.attribution`, related functions (Enter launches one), the last `traceId`. Focus moves into the overlay; `Esc` closes. | `fn.help { mode:'function' }` |
| `F1` again within 10 s, or `F1` while the overlay is open | `TicketDialog`: `POST /api/v1/help/tickets` pre-filled with `panelId`, `functionCode`, `security`, `params`, `screenState` (visible field ids + their `provIdx`), `traceId`, last error; the user types the question; `GO` submits; the confirmation shows `ticketId` and opens the `helpdesk` room (`MSG` in the next panel). No 24/7 desk exists (BRIEF §1); tickets are answered by `helpdesk` users at `HELP TICKETS`. | `ticket.open` |
| `HELP <CODE>` | Help for that function without launching it (variant of the panel's asset class when applicable). | `fn.help` |
| `HELP <text>` | Search: trigram similarity over manifest `name`, `help.summary`, `help.description`, `help.params[].text` and the field dictionary (`label`, `definition`); ranked hits with snippet; Enter opens the hit's help (function) or field definition. | `fn.help { mode:'search' }` |
| `HELP` with an empty panel | Index: functions grouped by tier with summaries, shell commands, reserved keys, the yellow key map. | `fn.help { mode:'index' }` |
| `HELP TICKETS` | Own tickets (all tickets for `helpdesk`/`admin`), status, answer; Enter opens the room. | — |

`HELP` is itself a manifest (`packages/core/src/functions/manifests/HELP.ts`, category `system`,
`assetClasses:'none'`, not pageable) so that `HELP …` typed on the command line, `/functions/HELP/run`
and the SDK behave identically:

```ts
export const HelpParams = z.object({
  code: z.string().max(6).optional(), query: z.string().max(200).optional(),
  assetClass: AssetClass.optional(), view: z.enum(['function', 'search', 'index', 'tickets']).default('index'),
});
// paramGrammar: positional [{ name:'code', type:'string', optional:true }], rest { name:'query', type:'text' }; 'TICKETS' as code selects view 'tickets'
export type HelpPayload =
  | { variant: 'default'; view: 'function'; function: { code: string; name: string; tier: Tier; variant: string | null; help: HelpSpec; params: Array<{ name: string; schema: unknown; default: unknown }>; csvColumns: CsvColumn[] | null; fields: Array<{ id: FieldId; label: string; definition: string; sourceId: string; attribution: string }>; keys: KeyBinding[] } }
  | { variant: 'default'; view: 'search'; query: string; hits: Array<{ kind: 'function' | 'field' | 'topic' | 'shell'; id: string; title: string; snippet: string; score: number }> }
  | { variant: 'default'; view: 'index'; tiers: Array<{ tier: Tier; functions: Array<{ code: string; name: string; summary: string; aliases: string[] }> }>; shell: Array<{ word: string; text: string }>; keys: Array<{ key: string; action: string }> }
  | { variant: 'default'; view: 'tickets'; tickets: Array<{ ticketId: number; openedAt: string; functionCode: string | null; question: string; status: 'open' | 'answered' | 'closed'; roomId: number | null; answer: string | null; answeredAt: string | null }> };
```

CSV for HELP: `section,key,text`. The overlay and the `HELP` screen render the same payload; the overlay
is the `function` view mounted over the current screen instead of replacing it.

---

## 5. SECF — Security Finder

`SECF [query] [AC=<assetClass>] [EXCH=<code>] [STATUS=all]` opens a full-panel finder in the current
panel. It is the answer to `NO SECURITY LOADED` and to any unresolved ticker.

```ts
export const SecfParams = z.object({
  query: z.string().max(80).default(''),
  assetClass: AssetClass.optional(), sector: MarketSector.optional(),
  exchange: z.string().max(4).optional(), country: z.string().length(2).optional(),
  status: z.enum(['active', 'all']).default('active'),
  indexMember: z.string().optional(),                    // 'SPX' → only members
  sort: z.enum(['rank', 'ticker', 'name']).default('rank'),
  pageSize: z.number().int().min(20).max(200).default(50),
});
// paramGrammar: rest { name:'query', type:'text' }; keyed AC → assetClass (enum), EXCH → exchange, STATUS → status, IDX → indexMember (index)
export interface SecfPayload {
  variant: 'default';
  hits: Array<{ instrument: InstrumentSummary; matchedOn: Candidate['matchedOn']; matched: Array<[number, number]>; score: number;
                identifiers: { figi: string | null; isin: string | null; cusip: string | null }; memberOf: string[]; listings: number; gicsSector: string | null }>;
  total: number;
  facets: { assetClass: Record<string, number>; exchange: Record<string, number>; status: Record<string, number> };
  source: 'master' | 'master+yahoo';
}
```

Resolver (`server/src/functions/SECF/resolve.ts`): `ctx.data.reference.search(q)` implements
`rank()` over the server snapshot for `query`, then filters by `assetClass`/`sector`/`exchange`/`country`/
`status`/`indexMember` with one SQL query over current `instruments` rows (`upper(ticker) LIKE q || '%'`
via `instruments_ticker_idx`, `name % q` via `instruments_name_trgm`, `identifiers` for exact
ISIN/CUSIP/FIGI), joins `index_members` (current) for `memberOf`, and pages with `ctx.page`
(cursor = `score desc, instrument_id`). When the master has fewer than 3 hits and `query` has ≥ 3 chars,
the Yahoo search adapter contributes hits marked `source:'master+yahoo'`; `Enter` on such a row calls
`/ref/resolve` (which may create a master row from OpenFIGI, API.md §5.1 `source:'openfigi'`).

Screen: query `form` field (focused, pre-filled from the command line; re-runs on `Enter` or 300 ms
after typing, `launchKind:'param'`) | asset-class tabs `1` All, `2` Equity, `3` ETF, `4` Index,
`5` Curncy, `6` Govt, `7` Rate/Econ, `8` Crypto | results `grid` (ticker key, name, type, exchange, ccy,
status, index membership, FIGI) | detail `kv` for the focused row (identifiers, listings, sector). Keys:
`Enter` → `DES` in this panel · `Shift+Enter` → `DES` in the next panel · `Ctrl+W` add to the active
watchlist · `X` exchange filter prompt · `S` status toggle · `PageUp/PageDown` pages. CSV:
`key,name,assetClass,securityType,exchange,currency,figi,isin,cusip,status,memberOf`. The local
autocomplete already covers the first keystrokes; SECF exists for filters, facets, paging and the
server-only identifier searches.

---

## 6. Catalogue (BRIEF §6)

Every code below has one manifest file and one entry in the tier file named in the last column. Asset
classes and variants are binding; the tier files may not narrow or widen them without changing this table.

| Code | Aliases | Name | Tier | Category | Asset classes (→ variants) | Purpose | Doc |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DES` | `DESC` | Security Description | 1 | reference | equity, etf → `equity`; index → `index`; fx → `fx`; govt → `govt`; option → `option`; crypto → `crypto`; rate → `rate`; econ → `econ` | Canonical landing screen: profile, identifiers, live stats, terms, membership, filings, news; differs entirely by asset class (FUNC-02) | TIER1 |
| `GP` | `GRAPH`, `CHART` | Price Graph | 1 | charting (custom) | equity, etf → `equity`; index → `index`; fx → `fx`; govt → `govt`; option → `option`; crypto → `crypto`; rate, econ → `series` | Daily-to-decade chart with overlays, normalisation, events and studies (CHRT-01..07) | TIER1 |
| `GIP` | `INTRA` | Intraday Price Graph | 1 | charting (custom) | equity, etf, index, fx, crypto, option → `intraday` | 1-/5-minute bars with VWAP, sessions and the forming bar streamed | TIER1 |
| `HP` | `HIST` | Historical Price Table | 1 | pricing | equity, etf, index, fx, crypto → `price`; govt, rate, econ → `series` | Any periodicity, any adjustment basis, pageable, exportable (REF-09) | TIER1 |
| `Q` | `QUOTE`, `QR` | Quote | 1 | pricing | equity, etf, index, fx, option, crypto, rate → `quote` | Live composite quote, per-line view with three timestamps, tape (FEED-05, BUS-05) | TIER1 |
| `QM` | `MON` | Quote Monitor | 1 | monitor | none → `default` | Live grid over a watchlist, index members or a key list; sort/group; flash (TERM-08) | TIER1 |
| `W` | `WL`, `WATCH` | Watchlists | 1 | monitor | none → `default` | User watchlists with computed formula columns, shareable (CHRT-07) | TIER1 |
| `TOP` | `TOPN` | Top News | 1 | news | none → `default` | Ranked headline feed by topic, live prepend | TIER1 |
| `N` | `NEWS` | News Search | 1 | news | any (optional security) → `default` | Full-text and trigram search over the normalised news stream, saved searches, alerts | TIER1 |
| `NI` | `NEWSI` | News by Topic | 1 | news | none → `default` | Topic-code browser and feed (`NI FED`) | TIER1 |
| `MSG` | `IB`, `CHAT` | Messaging | 1 | messaging | none → `default` | Person-to-person and room chat with inline security/function/chart sharing, compliance policy (MSG-01..04) | TIER1 |
| `WEI` | `INDICES` | World Equity Indices | 1 | monitor | none → `default` | Global index monitor by region with returns and session state — the default morning screen | TIER1 |
| `HELP` | — | Help | 1 | system | none → `default` | §4: explain the current screen; second press opens a ticket (TERM-09) | TIER1 |
| `SECF` | `SF`, `FIND` | Security Finder | 1 | reference | none → `default` | §5: filtered, faceted, paged security search | TIER1 |
| `FA` | `FIN` | Financial Analysis | 2 | fundamentals | equity → `equity`; etf → `fund` (NAV/holdings summary, statements not applicable) | Standardised IS/BS/CF/ratios from SEC XBRL, point-in-time by `knownAt`, as-reported toggle (STOR-06) | TIER2 |
| `EE` | `ERN` | Earnings | 2 | fundamentals | equity → `equity` | SEC actuals history, next expected report date; estimate columns unavailable with reason (BRIEF §2) | TIER2 |
| `EQS` | `SCREEN` | Equity Screening | 2 | screening | none → `default` | Multi-factor screens over the universe (`xbrl_frames`, nightly factors), saved screens | TIER2 |
| `RV` | `COMP`, `PEERS` | Relative Valuation | 2 | fundamentals | equity → `equity` | Peer set by GICS sub-industry/sector/custom with comparative multiples and percentiles | TIER2 |
| `CN` | `CNEWS` | Company News | 2 | news | equity, etf → `issuer`; index → `members` | Issuer-linked news and filings as pseudo-headlines, precision-first links (NEWS-02) | TIER2 |
| `CACS` | `CA`, `ACTIONS` | Corporate Actions | 2 | reference | equity, etf → `issuer`; index → `members` | Dividend/split/name-change/earnings timeline with estimated/announced/confirmed states (DATA-08) | TIER2 |
| `CF` | `FILINGS` | Company Filings | 2 | fundamentals | equity, etf → `issuer` | SEC filings list with form filters, items, links, XBRL flag | TIER2 |
| `ECO` | `CAL`, `CALENDAR` | Economic Calendar | 2 | monitor | none → `default` | Releases by week/day with actual/prior/revised; consensus unavailable with reason; FOMC dates | TIER2 |
| `PORT` | `PRT` | Portfolio Analytics | 2 | portfolio | none → `default` | Holdings, Brinson attribution, exposure, tracking error/VaR, scenarios, reconciliation (PORT-01..06, tenant-isolated PORT-07) | TIER2 |
| `HDS` | `HOLD`, `HOLDERS` | Holders | 2 | fundamentals | equity → `equity` (ETF holders, insiders); etf → `fund` (its holdings) | Ownership from N-PORT/SSGA; 13F reserved (`13F_NOT_AVAILABLE`) | TIER2 |
| `MEMB` | `MEMBERS` | Index Members | 2 | reference | index → `index` (or none with `index` arg) | Constituents with weights, sector subtotals, adds/drops between dates (REF-07) | TIER2 |
| `BTMM` | `MMKT` | Treasury & Money Markets | 2 | monitor | none → `default` | Policy range, overnight rates with percentiles, bills, CMT, spreads, FX and indices on one page | TIER2 |
| `FXC` | `FX`, `CROSS` | FX Cross Matrix | 2 | monitor | none → `default` | G10 cross matrix, direct pairs live, crosses derived via USD, ECB reference toggle | TIER2 |
| `WB` | `BONDS` | World Bond Markets | 2 | monitor | none → `default` | Benchmark yields by country (US daily, others monthly OECD via FRED) with spreads to UST | TIER2 |
| `YAS` | `YA` | Yield & Spread Analysis | 3 | rates | govt → `govt` | Price↔yield, accrued, duration/convexity/DV01/KRDs, spread to curve, cashflows (ANAL-01, ANAL-08) | TIER3 |
| `CRVF` | `ICVS` (→ `curveId:'SOFR_OIS'`), `CURVE`, `OIS` | Curve Construction | 3 | rates (custom) | none → `default` | Treasury par/bill/CMT and SOFR OIS curves: bootstrap, interpolation, par/zero/df/forwards, date compare (ANAL-02) | TIER3 |
| `WIRP` | `FFIP`, `PATH` | Implied Policy Path | 3 | rates | none → `default` | FOMC-dated implied overnight path and hike/cut probabilities from the money-market curve (BRIEF §2) | TIER3 |
| `OVML` | `OV`, `OPTVAL` | Option Valuation | 3 | derivatives | option → `contract`; equity, etf, index → `underlying` (ATM contract picked) | BSM/Black-76/CRR/trinomial/MC pricing with greeks, implied vol, scenario grid (ANAL-03) | TIER3 |
| `OMON` | `CHAIN` | Option Monitor | 3 | derivatives | equity, etf, index → `underlying` | Straddle chain by expiry with Cboe greeks/IV, ATM highlight, smile (ANAL-04) | TIER3 |
| `SWPM` | `SWAP` | Swap Manager | 3 | rates | none → `default` | SOFR OIS swap pricing: schedules, NPV, par rate, DV01, key-rate risk (ANAL-02) | TIER3 |
| `SRCH` | `BSRCH` | Treasury Search | 3 | screening | none → `default` | Screen Treasuries by type, maturity, coupon, benchmark status; yields from the curve | TIER3 |
| `GC` | `GCRV` | Benchmark Curve Chart | 3 | charting (custom) | none → `default` | Treasury/CMT/SOFR curve on several dates with basis-point change table | TIER3 |
| `FED` | `FOMC` | Fed Monitor | 3 | monitor | none → `default` | Policy range, EFFR/SOFR/IORB, FOMC calendar with implied moves, balance sheet, Fed press | TIER3 |
| `CRYP` | `CRYPTO` | Crypto Monitor | 3 | monitor | none → `default` | Context-only crypto prices from CoinGecko, flagged `CONTEXT_ONLY_NOT_EXCHANGE_DATA` | TIER3 |

Counts: 14 + 14 + 10 = 38 manifests; `IB` and `ICVS` are aliases (BRIEF writes them as `MSG`/`IB`
and `CRVF`/`ICVS`). `MA`/`LEAG` from the REQUIREMENTS table are not in BRIEF §6 and have no source in
the wedge; they are recorded in TRACEABILITY.md as out of scope with reason.

---

## 7. Template for `FUNCTIONS_TIER1.md`, `FUNCTIONS_TIER2.md`, `FUNCTIONS_TIER3.md`

### 7.1 File skeleton

Each tier file starts with a two-line header (`# FUNCTIONS_TIER<n> — <tier description>` and one
sentence pointing at this document) and then one entry per catalogue row, in §6 order, using exactly
the headings below (level 3 for the function, level 4 for its sections; every section present, none
renamed, none empty — write `None.` when a section genuinely has nothing):

````markdown
### <CODE> — <Name>

| Attribute | Value |
| --- | --- |
| Code / aliases | `<CODE>` / `<ALIAS>`, … (`aliasParams` when any) |
| Tier / category | <n> / <category> |
| Asset classes → variants | `equity, etf → equity; index → index` (or `none → default`, `any → default`) |
| requiresSecurity / pageable / screenKind | `true` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/<CODE>.ts` · `packages/server/src/functions/<CODE>/resolve.ts` · `packages/web/src/screens/<CODE>/Screen.tsx` · `fixtures/golden/functions/<CODE>.<variant>.{json,csv}` |
| Requirements | (FUNC-02), (TERM-08), … — every ID this function satisfies, cited again inline where satisfied |

#### Params
```ts
export const <Code>Params = z.object({ … });          // verbatim from the manifest file; every optional has .default()
```
#### Argument grammar
`positional [ … ]`, `keyed { … }`, `rest …` — as a ParamGrammar literal, followed by three example command lines and the params they produce.

#### Payload
```ts
export type <Code>Payload = { variant: '<v1>'; … } | { variant: '<v2>'; … };   // verbatim from the manifest file; ValueCell for every live/provider number (§1.3)
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `instruments`, `bars_daily`, … (read as-of `ctx.asOf`; PIT tables read with `knownAt`) |
| Data services (§1.4.2) | `data.historical.bars`, `plant.snapshot`, … |
| Read-through (`providers.ensure`) | `('sec.submissions', cik, { maxAgeMs: 6h })`, … or `None.` |
| Engines (`core/analytics`) | `bond/price@1.x`, … or `None.` |
| Subjects (live) | `q:<instrumentId>`, … or `None.` |
| Field ids (`fieldIds(assetClass)`) | per variant: `equity: [PX_LAST, …]` — the entitlement pre-check set |

#### Resolver
Numbered steps from `ctx` to payload per variant, naming every service call, TTL, provenance citation (`ctx.prov.add`/`addQuote`), `ctx.unavailable.add` case, engine call and `ctx.page` handling. State the p95 budget (Tier 1: first paint < 500 ms) and the number of DB round-trips.

#### Live
`live(params, payload)` result verbatim (`{ subjects, fields, conflationMs?, essential? }`) or `null`, and how the screen maps subjects to cells (`Cell.live`, `grid.live.subjectOf`).

#### Screen
ASCII layout of the `ScreenSpec` (node kinds and ids), per variant when they differ; the title/subtitle format; footer sources; `initialFocus`; skeleton while `payload === undefined`; how `meta.entitlement`/`meta.unavailable` are rendered (badges, `—` with reason).

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `G` | always | `open-gp` | `ctx.navigate('GP')` |
(one row per `keymap` entry; only keys allowed by §2.6; `Enter`/`Shift+Enter` row semantics for grids and lists; number keys for tabs)

#### CSV
`filename` template; `columns` (static list, or the rule when payload-dependent); `rows` rule per variant; long-format `section` layout when multi-block (§1.6 rule 3); one example row.

#### Help
`summary` (≤ 80 chars), `description` (the exact text), `params[]`, `sources[]` (licence ids), `related[]`.

#### Unavailable and reason codes
Every `meta.unavailable` entry the resolver can emit (`field`, `reason`, `detail`) and every function-specific footer message (`NO_ESTIMATES_SOURCE`, `DEPTH_UNAVAILABLE_SOURCE`, `13F_NOT_AVAILABLE`, …).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules (shared) |
| golden payload | `packages/server/test/integration/functions/<CODE>.golden.test.ts` | resolver output at the frozen clock deep-equals `fixtures/golden/functions/<CODE>.<variant>.json` for every variant and seed security |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `<CODE>.<variant>.csv`; every numeric cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/<CODE>.test.tsx` | renders each golden variant; every keymap action reachable by keyboard; live cells registered; `payload undefined` renders the skeleton |
| function-specific | named files | e.g. PIT restatement (FA), adjust policies (HP), NOT_APPLICABLE (YAS on equity), page cursors |
| e2e (Tier 1 only, or when listed in ARCHITECTURE §3.5) | `packages/e2e/tests/<name>.spec.ts` | the user-visible flow |
````

### 7.2 Rules for the tier files

1. Everything in code fences is copied from, or into, the source files verbatim — the tier file is the
   review artefact for the manifest; a reviewer diffs them.
2. Every requirement satisfied is cited inline `(REQ-ID)` where it is satisfied, in addition to the
   attribute table.
3. No `TBD`, no "as above", no "similar to X": an engineer implementing only this entry, with this
   document, ARCHITECTURE.md, API.md and DATA_MODEL.md open, must not need to talk to anyone.
4. Asset classes, variants, aliases and category must match §6; field ids must exist in
   `core/fields/dictionary.ts` (API.md §7); table names must exist in DATA_MODEL.md; subjects must
   match the grammar of ARCHITECTURE §6.1; provider ids must be `licence_registry.source_id` values.
5. Key bindings must respect §2.6; number keys `1`–`9` are reserved within a screen for tabs when the
   screen has tabs.
6. Every payload number that can be blank because of entitlement or absence is a `ValueCell`; every
   unavailable-by-design column has a reason code listed under "Unavailable and reason codes".
7. `pageable:true` entries must state the cursor encoding (`base64url(JSON)` of the last sort key) and
   what PAGE FWD means (older, next expiry, next week…).
8. Screens with a `custom` node must state the `ChartSpec` they build (§1.5) in the Screen section.

### 7.3 Worked example — `CRYP` (normative; `FUNCTIONS_TIER3.md` reproduces this entry verbatim)

### CRYP — Crypto Monitor

| Attribute | Value |
| --- | --- |
| Code / aliases | `CRYP` / `CRYPTO` |
| Tier / category | 3 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/CRYP.ts` · `packages/server/src/functions/CRYP/resolve.ts` · `packages/web/src/screens/CRYP/Screen.tsx` · `fixtures/golden/functions/CRYP.default.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-03) (FUNC-04) (TERM-08) (TERM-12) (DATA-10) (ENTL-05) |

#### Params
```ts
export const CrypParams = z.object({
  ids: z.array(z.enum(['bitcoin', 'ethereum', 'solana', 'ripple'])).min(1).max(4).default(['bitcoin', 'ethereum', 'solana', 'ripple']),
  sort: z.enum(['name', 'px', 'chg']).default('name'),
});
```
#### Argument grammar
`positional [{ name:'ids', type:'string', optional:true }]` (comma-separated CoinGecko ids), `keyed { SORT: { name:'sort', type:'enum', values:['name','px','chg'] } }`, no `rest`.
Examples: `CRYP` → `{ ids:[all four], sort:'name' }` · `CRYP bitcoin,ethereum` → `{ ids:['bitcoin','ethereum'] }` · `CRYP SORT=CHG` → `{ sort:'chg' }`.

#### Payload
```ts
export type CrypPayload = {
  variant: 'default';
  rows: Array<{ instrumentId: number; key: string /* 'BTC Crypto' */; name: string; coingeckoId: string; px: ValueCell; chg24hPct: ValueCell; asOf: string }>;
  source: 'coingecko.simple';
  caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA';
};
```
#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables | `instruments` (asset_class `crypto`, current versions), `md_lines` (`coingecko.simple`), `quote_snapshots` (plant warm start) |
| Data services | `data.reference.instrument`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through | `providers.ensure('coingecko.simple', 'bitcoin,ethereum,solana,ripple', { maxAgeMs: 60_000 })` when any subject is `blank` |
| Engines | None. |
| Subjects (live) | `q:<instrumentId>` for each row |
| Field ids | `default: [PX_LAST, CHG_PCT_1D, LAST_TRADE_TIME]` |

#### Resolver
1. Map `params.ids` to instruments: one query over current `instruments` joined to `md_lines` where `source_id='coingecko.simple' AND provider_symbol = ANY(ids)`; unknown ids → `ctx.unavailable.add({ field: id, reason:'NO_SOURCE', detail:'not a seeded CoinGecko id' })`.
2. `subjects = ids.map(plant.subjectFor)`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`.
3. If any state is missing or `st === 'blank'`: `providers.ensure(...)` once, then `snapshotMany` again.
4. For each row: `px = { v: state.fields.PX_LAST ?? null, st: state.state, r: state.r?.PX_LAST, ts: state.fieldTs.PX_LAST, provIdx: ctx.prov.addQuote(state), live: { subject, field:'PX_LAST' } }`; `chg24hPct` likewise from `CHG_PCT_1D` (CoinGecko `usd_24h_change`, normalised by the adapter into `CHG_PCT_1D`); `asOf = ISO(state.ts.src ?? state.ts.cap)`.
5. Sort per `params.sort` (name asc, px desc, chg desc); return `{ variant:'default', rows, source:'coingecko.simple', caveat:'CONTEXT_ONLY_NOT_EXCHANGE_DATA' }`.
Budget: one DB query, zero provider calls when hot; < 50 ms p95.

#### Live
`{ subjects: rows.map(r => 'q:' + r.instrumentId), fields: ['PX_LAST', 'CHG_PCT_1D', 'LAST_TRADE_TIME'], conflationMs: 1000 }`; the grid's `live.subjectOf = row => row.subject`.

#### Screen
```
┌ CRYP · Crypto Monitor · context only ─────────────────────────────┐
│ badges#caveat  [CONTEXT_ONLY_NOT_EXCHANGE_DATA · source CoinGecko] │
│ grid#rows  key | name | px (live, fmt px) | chg24h% (live, pct)    │
│            | as-of (datetime) | state glyph                        │
│ footer: sources ['CoinGecko simple price (context only)'] asOf     │
└───────────────────────────────────────────────────────────────────┘
```
Title `CRYP · Crypto Monitor`; `initialFocus:'rows'`; skeleton = grid with 4 muted rows; denied fields render `—` with the reason from `meta.entitlement`.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `Enter` | grid | `open-des` | `ctx.navigate(row.key + ' DES')` (crypto DES variant) |
| `Shift+Enter` | grid | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `G` | grid | `open-gp` | `ctx.navigate(row.key + ' GP')` |
| `S` | always | `cycle-sort` | `ctx.setParams({ sort: next })` (usage `fn.param`) |
| `Ctrl+W` | grid | `add-watchlist` | `ctx.prompt('watchlist')` then `sdk.watchlists.setItems` |

#### CSV
`filename = 'CRYP_' + asOf.replace(/[-:]/g,'') + '.csv'`; columns `key,name,coingeckoId,px,chg24hPct,asOf,source`; one row per `rows[]` (`px.v`, `chg24hPct.v`). Example: `BTC Crypto,Bitcoin,bitcoin,115234.12,-1.83,2026-09-15T18:41:28Z,coingecko.simple`.

#### Help
summary `Context-only crypto prices (CoinGecko), not exchange data`; description `CRYP shows spot prices and 24-hour changes for the seeded crypto assets from CoinGecko's simple-price endpoint. Values are indicative and are not exchange or venue prices; there is no order book, no volume and no session state. Use DES on a row for the instrument record and GP for history.`; params `ids` ("CoinGecko ids, comma-separated", example `bitcoin,ethereum`), `sort` ("name, px or chg"); sources `['coingecko.simple']`; related `['DES', 'GP', 'WEI']`.

#### Unavailable and reason codes
`{ field: <id>, reason:'NO_SOURCE', detail:'not a seeded CoinGecko id' }` for unknown ids; entitlement denials per field via `meta.entitlement` (`NO_FIRM_ENTITLEMENT` for a firm without the `coingecko.simple` grant); `PROVIDER_DOWN` → cells `stale` with last values (TERM-12).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 |
| golden payload | `packages/server/test/integration/functions/CRYP.golden.test.ts` | equals `CRYP.default.json` from `coingecko-simple.json` at the frozen clock |
| csv parity | `packages/core/test/functions/csv.test.ts` | equals `CRYP.default.csv` |
| parity | `packages/server/test/parity/fn-parity.test.ts` | shared |
| screen | `packages/web/test/screens/CRYP.test.tsx` | four rows, live cells registered for `q:*`, `S` cycles sort via `setParams`, skeleton |
| provider down | `packages/server/test/integration/functions/CRYP.stale.test.ts` | circuit open → `st:'stale'`, `meta.staleness:'stale'`, no throw |

---

## 8. Tests owned by this contract

| Area | File | What it proves |
| --- | --- | --- |
| Manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules 1–6 over the generated barrel |
| Registry | `packages/core/test/functions/registry.test.ts` | alias resolution, `applicable()`, `version` stability, duplicate detection |
| CSV | `packages/core/test/functions/csv.test.ts` | §1.6 rules; RFC 4180 quoting of commas/quotes/CRLF; goldens |
| Tokenizer/parser | `packages/core/test/command/parser.test.ts` | every row of §2.7 |
| Parser fuzz (QA-05) | `packages/core/test/command/parser.fuzz.test.ts` | 100 k random strings (unicode, `<`, `/`, `=`): never throws, spans within bounds, `parse(raw)[0]` idempotent under re-parse of `insertText` |
| Args | `packages/core/test/command/args.test.ts` | every `ArgType` syntax in §2.4 |
| Ranking | `packages/core/test/command/rank.test.ts` | R0–R3, each score term, tie-breaks, the `W`/`CF`/`GP` cases |
| Index | `packages/core/test/command/index.test.ts` | prefix bounds, word index, trigram fallback thresholds |
| Bench | `packages/core/test/command/command.bench.ts` | ≤ 4 ms p95 on 45 k entries |
| Local index | `packages/web/test/command/localIndex.test.ts` | ETag/IndexedDB cache, Worker build, MRU rebuild from history |
| Dispatch | `packages/web/test/command/dispatch.test.ts` | §2.5 table, frame stack, `fn.launch` event, traceId minting |
| Keymap | `packages/web/test/keyboard/keymap.test.ts` | reserved keys, Escape priority, yellow keys, typing-anywhere routing |
| Screen renderer | `packages/web/test/screen/renderer.test.tsx` | every `Node` kind keyboard-operable; `Cell` states render distinctly; provenance panel |
| Runner | `packages/server/test/unit/functions/runner.test.ts` | steps 1–11 of §1.4.3 including every error code, alias params, variant assertion |
| Export | `packages/server/test/integration/functions/export.test.ts` | resultId path, regenerated path, denied field → 403, headers, usage row |
| Parity | `packages/server/test/parity/fn-parity.test.ts` | every manifest × seed securities: JSON = CSV = WS snapshot (API-05) |
| Usage | `packages/server/test/integration/usage.test.ts` | one row per launch/param/page/export; `params_hash`; client batch route; `/usage/functions` |
| Help | `packages/server/test/integration/help.test.ts` | help per variant, search ranking, ticket creation and room |
| SECF | `packages/server/test/integration/functions/SECF.test.ts` | filters, facets, paging, Yahoo fallback marking |
| e2e | `packages/e2e/tests/{command-line,autocomplete,help,export}.spec.ts` | ARCHITECTURE §3.5 |

---

## 9. Decision log (where the candidates disagreed or the final docs needed reconciling)

| Topic | Chosen | Why (one line) |
| --- | --- | --- |
| Manifest fields | ARCHITECTURE §5.2 (`fieldIds()` function, `LiveSpec.conflationMs`, `CsvDocument.asOf`) plus `variants`, `aliasParams`, `payloadVersion` | B's `fieldClasses` cannot express per-asset-class entitlement sets; `variants` is needed by goldens/help/screens; `ICVS` needs alias defaults; API.md §11 versions payloads by manifest. |
| Resolver return type | payload only (ARCHITECTURE §5.1); staleness/tier via `ctx.prov`, page via `ctx.page.set` | One `meta` builder in the runner instead of every resolver assembling `ResolveResult`. |
| Screen file path | `packages/web/src/screens/<CODE>/Screen.tsx` (ARCHITECTURE §3.4) not `web/src/functions/<CODE>` (B) | Final ARCHITECTURE is authoritative for paths. |
| Trace id | UUID v4 (ARCHITECTURE §15) not ULID (B); `resultId` stays a ULID (API.md §3) | Result ids are sortable cache keys; trace ids are not. |
| HELP double-press window | 10 s (ARCHITECTURE §5) not 1.5 s (B) | A user reads the overlay before deciding to ask a human. |
| `/` prefix | `/scheme/value` (API.md `SecurityRefInput`) is a security; any other leading `/` is a shell command | Both syntaxes survive with one regex; no wire change. |
| Formula on the command line | `<…>` canonical, bare `NAME(…)` accepted; wire carries the bare formula string | API.md `{ formula }` has no brackets; brackets only disambiguate typing. |
| `H` alias for HELP | dropped | `H US Equity` (Hyatt) is a real ticker; `HELP` is four keystrokes. |
| Function vs ticker collisions (`W`, `CF`, `WB`, `TOP`) | hard rule R0: exact applicable function code wins; sector or row 2 reaches the ticker | Matches Bloomberg behaviour; deterministic; the alternative is always one row away. |
| Option contracts in the autocomplete snapshot | excluded | 3.5 k contracts per underlying would dominate prefix hits; OMON and the OCC/Bloomberg option syntax cover the need. |
| Usage event kinds | API.md §5.13 / DATA_MODEL §14 closed set (`fn.launch` …) not B's `function.launch` | Column CHECK constraint already fixed. |
| CSV shape | one table per document; multi-block screens use a `section` column | One parser for every export; API.md §9 example is one table. |
| SECF search route | none; SECF is an ordinary function run (`/functions/SECF/run`) over `data.reference.search` | Final API.md has no `/search/securities`; the framework already gives paging, usage and entitlement. |
| Yellow keys | Bloomberg F2–F11 sector layout, on-screen key bar as the guaranteed path | TERM-07 asks for physical-key semantics; browsers may swallow F5/F11, so the bar is the contract. |
| MENU key | `Escape` with nothing to cancel pops the frame stack; explicit `Alt+←/→` | Bloomberg MENU = "previous screen"; a second dedicated key would need a non-standard binding. |
| Read-through contract | `ensure(kind, key, { maxAgeMs })` freshness guarantee, resolver then reads `ctx.data` | Keeps raw provider shapes inside `providers/<name>/parse.ts` (FEED-03) and one read path for goldens. |

## 10. Open questions (not resolvable from the inputs)

1. **`W`, `CF`, `WB` as tickers with an empty panel.** R0 makes the function win whenever it is
   applicable; `W` and `WB` take no security, so the ticker is always row 2. If desks complain, the
   alternative is a per-user "prefer tickers" setting that flips `kindPrior` — a client setting, no
   contract change.
2. **`M-Mkt` sector.** Mapped to `rate` so `SOFR M-Mkt` resolves; API.md's examples use `SOFR Index`.
   Whether the display form of rate instruments should be `M-Mkt` rather than `Index` is a data-ops
   naming decision (`instruments.market_sector` seed value).
3. **People in the snapshot.** DATA_MODEL seeds ≈ 60 authors plus platform users; whether directory
   users of *other* firms are searchable (MSG-01 "verified global directory") is a compliance policy
   decision (`firms.policy`), not a ranking one — the ranker treats whatever the snapshot contains.
4. **Regenerated exports for live-plant functions.** Re-resolving `Q`/`QM` after the result cache expires
   yields current plant values, not the screen's values; the header says `regenerated: true`. If a
   frozen export is required after 10 minutes, the cache TTL or a persisted-result table is the lever.
5. **Yellow keys on macOS Chrome.** `F11` (Curncy) toggles fullscreen and cannot always be prevented;
   the on-screen key bar and typing `Curncy` are the guaranteed paths. Whether to remap Curncy to
   `Shift+F11` is a UX call for WP-11.
6. **Per-function `conflationMs` below the session default.** `LiveSpec.conflationMs` can request
   faster flushes than `hello.conflationMs` only if the session renegotiates (`conflation` message);
   the shell currently takes the minimum across visible screens, which changes the whole session's
   rate. Per-subject conflation would need a protocol addition (BUS-03).
