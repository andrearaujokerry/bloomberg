# FUNCTIONS — candidate B

A function is a **manifest** (pure, in `@terminal/core`), a **resolver** (server) and a **screen**
(client) that share one payload type. The manifest is the contract; the resolver and the screen are
implementations that cannot drift because both are typed by the manifest's `payload` type and
validated in tests against `fixtures/golden/functions/<CODE>.json`.

Contents: §1 framework contract · §2 command grammar, parser, autocomplete ranking · §3 HELP and
SECF semantics · §4 per-function manifests (Tier 1, 2, 3) · §5 usage instrumentation · §6 registry
generation.

---

## 1. Framework contract (FUNC-01/02/03/04)

### 1.1 Manifest (`packages/core/src/functions/manifest.ts`)

```ts
import { z } from 'zod';
import type { AssetClass, FieldClass, LatencyTier, StalenessTier } from '../quote/model';

export type Tier = 1 | 2 | 3;
export type FunctionCategory = 'reference' | 'pricing' | 'charting' | 'news' | 'fundamentals' | 'screening' | 'rates' | 'derivatives' | 'portfolio' | 'messaging' | 'monitor' | 'system';

/** Maps command-line args (after the function code) into params. */
export interface ParamGrammar {
  positional: Array<{ name: string; type: 'tenor' | 'range' | 'date' | 'number' | 'enum' | 'string' | 'security' | 'topic' | 'watchlist' | 'index' | 'currency'; values?: readonly string[]; optional?: boolean }>;
  keyed?: Record<string, { name: string; type: ParamGrammar['positional'][number]['type']; values?: readonly string[] }>;   // 'ADJ=TR' → params.adjust
  rest?: { name: string; type: 'text' };   // N <free text>
}

export interface LiveSpec { subjects: string[]; fields: string[] | '*'; conflateMs?: number }

export interface CsvColumn { id: string; label: string; type: 'string' | 'number' | 'date' | 'datetime' | 'boolean'; decimals?: number }
export interface CsvDocument { filename: string; attribution: string[]; columns: CsvColumn[]; rows: Array<Array<string | number | boolean | null>> }
export interface CsvSpec<P, T> {
  filename: (params: P, ctx: { securityKey: string | null; asOf: string }) => string;
  columns: CsvColumn[] | ((params: P, payload: T) => CsvColumn[]);
  rows: (payload: T, params: P) => CsvDocument['rows'];
}

export interface HelpSpec {
  summary: string;                                   // one line
  description: string;                               // shown on HELP ×1
  params: Array<{ name: string; text: string; example?: string }>;
  keys: Array<{ key: string; action: string }>;
  sources: string[];                                 // source ids (attribution shown)
  related: string[];                                 // function codes
}

export interface KeyBinding { key: string; action: string; when?: 'grid' | 'chart' | 'form' | 'always'; description: string }

export interface FunctionManifest<P extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>, T = unknown> {
  code: string;                       // canonical mnemonic, uppercase
  name: string;
  aliases: readonly string[];
  tier: Tier;
  category: FunctionCategory;
  assetClasses: readonly AssetClass[] | 'any' | 'none';   // 'none' = takes no security
  requiresSecurity: boolean;
  params: P;                          // zod object with defaults for every optional
  paramGrammar: ParamGrammar;
  fieldClasses: readonly FieldClass[];            // entitlement pre-check classes
  pageable: boolean;                  // PAGE FWD/BACK semantics
  live: ((params: z.infer<P>, payload: T) => LiveSpec | null) | null;
  csv: CsvSpec<z.infer<P>, T>;
  help: HelpSpec;
  keymap: readonly KeyBinding[];
  variants: Partial<Record<AssetClass, string>>;  // asset class → variant key ('equity' → 'equity'; 'etf' → 'equity')
  screenKind: 'declarative' | 'custom';           // custom = screen owns a canvas (GP/GIP/GC/CRVF)
  _payload?: T;                                   // phantom for typing
}

export const defineFunction = <P extends z.ZodObject<z.ZodRawShape>, T>(m: FunctionManifest<P, T>) => m;
```

### 1.2 Server resolver (`packages/server/src/functions/context.ts`)

```ts
export interface ResolveContext {
  user: AuthUser;                                  // { userId, firmId, role, sessionId }
  traceId: string;
  instrument: Instrument | null;                   // resolved as-of ctx.asOf (null for assetClasses 'none')
  asOf: { validAt: Date; knownAt: Date };
  db: Db;                                          // Drizzle, request transaction with app.* settings applied
  plant: PlantReader;                              // snapshot(subject), snapshotMany(subjects)
  providers: ReadThrough;                          // get(kind, key, { maxAgeMs }) → persisted or fetched
  entitlements: EntitlementView;                   // check(fieldClass, tier, usage) precomputed for ctx.instrument
  clock: () => Date;
  page?: { cursor: string | null; direction: 'fwd' | 'back' };
  prov: ProvenanceCollector;                       // add(ref) → index; every value cites one
}
export interface ResolveResult<T> { payload: T; stale: StalenessTier; tier: LatencyTier; page?: { index: number; count: number; cursor: string | null } }
export type FunctionResolver<P, T> = (ctx: ResolveContext, params: P) => Promise<ResolveResult<T>>;
export interface FunctionServerModule<P, T> {
  resolve: FunctionResolver<P, T>;                 // default / dispatcher
  variants?: Partial<Record<string, FunctionResolver<P, T>>>;   // keyed by manifest.variants values
}
```

`functions/runner.ts` selects `variants[manifest.variants[instrument.assetClass]] ?? resolve`,
rejects with `FUNCTION_NOT_APPLICABLE` when the asset class is not listed, and wraps the result
with `meta` (provenance refs collected via `ctx.prov`, staleness = worst of the cited sources).

### 1.3 Client screen (`packages/web/src/screen/types.ts`)

```ts
export interface ScreenProps<P, T> {
  payload: T | undefined;            // undefined while loading (screen renders its skeleton from the spec)
  params: P;
  instrument: InstrumentDto | null;
  meta: Meta | undefined;
  live: LiveView;                    // get(subject, field) → FieldValue with staleness; subscribe handled by shell
  ctx: { panelId: number; setParams(patch: Partial<P>): void; navigate(cmd: string): void; export(): void; focus(id: string): void; page(dir: 'fwd' | 'back'): void };
}
export type FunctionScreen<P, T> = (props: ScreenProps<P, T>) => ScreenSpec;

export interface ScreenSpec { title: string; subtitle?: string; body: Node; footer?: { sources: string[]; asOf?: string }; keymap?: KeyBinding[]; initialFocus?: string }
export type Node =
  | { kind: 'split'; dir: 'row' | 'col'; sizes: number[]; children: Node[] }
  | { kind: 'kv'; id: string; title?: string; rows: Array<{ label: string; value: Cell; provIdx?: number }>; columns?: 1 | 2 | 3 }
  | { kind: 'grid'; id: string; columns: GridColumn[]; rows: GridRow[]; live?: { subjectOf: (row: GridRow) => string }; sort?: SortSpec; groupBy?: string; selectable?: boolean; onEnter?: (row: GridRow) => string /* command */ }
  | { kind: 'table'; id: string; columns: CsvColumn[]; rows: Cell[][]; caption?: string }          // static, small
  | { kind: 'chart'; id: string; spec: ChartSpec }                                                    // CLIENT.md §8
  | { kind: 'tabs'; id: string; tabs: Array<{ id: string; label: string; key?: string; body: Node }>; active: string }
  | { kind: 'form'; id: string; fields: FormField[]; submitLabel?: string }
  | { kind: 'text'; id: string; text: string; mono?: boolean }
  | { kind: 'list'; id: string; items: Array<{ id: string; primary: string; secondary?: string; ts?: number; badges?: Badge[]; command?: string }>; onEnter?: 'command' }
  | { kind: 'badges'; items: Badge[] }
  | { kind: 'custom'; id: string; component: string; props: unknown };                              // registered custom widget (chart-heavy)
export interface Cell { v: string | number | boolean | null; fmt?: 'px' | 'pct' | 'bp' | 'int' | 'ccy' | 'date' | 'datetime' | 'text'; decimals?: number; stale?: StalenessTier; reason?: string; dir?: 'up' | 'down' | 'flat'; live?: { subject: string; field: string } }
```

The shell's `ScreenRenderer` renders any `ScreenSpec` with a fixed widget set; every widget is
keyboard-operable (CLIENT.md §4). A `custom` node hosts a registered component (`'PriceChart'`,
`'CurveChart'`, `'OptionSurface'`) built on the chart engine; those still receive `ScreenProps`.

### 1.4 CSV exporter

`core/functions/csv.ts#toCsv(manifest, payload, params, ctx): CsvDocument` — the only serialiser,
used by the server export route (from the cached payload) and by tests. The client never serialises
locally (entitlement check on export happens server-side, FUNC-03). Numbers are emitted at full
precision; the screen's display formatting is a view concern.

### 1.5 Registry

```ts
export class FunctionRegistry {
  constructor(manifests: FunctionManifest[]);
  get(codeOrAlias: string): FunctionManifest | undefined;    // case-insensitive, aliases resolved
  all(): FunctionManifest[];
  byTier(t: Tier): FunctionManifest[];
  applicable(assetClass: AssetClass | null): FunctionManifest[];
  isFunctionToken(token: string): boolean;                   // used by the command parser
}
export const registry = new FunctionRegistry(Object.values(manifests));   // core/functions/manifests/index.ts (generated barrel)
```

### 1.6 Polymorphism by asset class (FUNC-02)

`manifest.variants` maps each supported asset class to a variant key; the server module exports a
resolver per key; the client screen switches on `props.instrument.assetClass`. DES on
`AAPL US Equity`, `SPX Index`, `T 4.25 08/15/35 Govt`, `AAPL US 09/18/26 C330 Equity` and
`SOFRRATE Index` are five payload shapes behind one code, discriminated by `payload.variant`.

---

## 2. Command grammar, parser and autocomplete ranking (TERM-01/02/03)

### 2.1 Grammar

```
command     := ws* (security ws+)? (function (ws+ args)?)? ws*
security    := formula | identifier | ticker_key
formula     := '<' any+ '>'                                   ; CHRT-07 formula, e.g. <AAPL US Equity / MSFT US Equity>
identifier  := FIGI | ISIN | CUSIP | OCC                       ; recognised by shape + check digit (FIGI: BBG + 9 alnum)
ticker_key  := ticker_tokens ws+ sector                        ; 'AAPL US Equity', 'T 4.25 08/15/35 Govt', 'AAPL US 09/18/26 C330 Equity'
             | ticker_tokens                                    ; sector omitted → resolved by ranking (Equity first)
ticker_tokens := token (ws+ token){0,5}
sector      := 'Equity'|'Index'|'Curncy'|'Govt'|'Corp'|'Comdty'|'Mtge'|'Muni'|'Pfd'|'M-Mkt'|'Crypto'   ; case-insensitive, unique prefix ≥ 3 chars accepted ('Equ', 'Cur')
function    := CODE                                             ; 1–6 [A-Z0-9], registry code or alias
args        := token (ws+ token)*                               ; interpreted by manifest.paramGrammar
token       := [^ \t]+
```

Special forms: `HELP [CODE|text]`, `N <free text>`, `TOP [TOPIC]`, `NI <TOPIC>`, `ECO [country]`,
`MEMB <INDEX>`, `W [name]`, `MSG [person]`. A leading `/` is a shell command (`/panel 2`,
`/layout 4`, `/conflate 100`, `/theme`) and never reaches the function parser.

### 2.2 Tokenizer and parser (`core/command/*.ts`)

```ts
export interface Token { text: string; start: number; end: number; upper: string }
export interface ParsedCommand {
  raw: string;
  security?: { ref: SecurityRef; span: [number, number]; sectorGiven: boolean; text: string };
  functionCode?: string;              // canonical code (alias resolved)
  args: string[];
  argSpan?: [number, number];
  shape: 'empty' | 'security' | 'function' | 'security+function' | 'shell' | 'help' | 'invalid';
  problems: Array<{ code: 'UNKNOWN_FUNCTION' | 'UNKNOWN_SECTOR' | 'ARG_PARSE' | 'AMBIGUOUS'; span: [number, number]; message: string }>;
}
export function parse(raw: string, env: ParseEnv): ParsedCommand[];   // ranked interpretations, best first
export interface ParseEnv { registry: FunctionRegistry; hasSecurity: boolean; isKnownTicker(tokens: string[]): boolean }
```

Algorithm (deterministic, no IO):

1. Tokenise on whitespace, keep spans. Empty → `shape:'empty'`.
2. If `raw` starts with `/` → `shell`. If first token is `HELP`/`H` → `help` with the rest as args.
3. **Sector anchor.** Find the last token index `k ≤ 6` whose upper form is a sector (or unique
   ≥ 3-char prefix). If found: `security = tokens[0..k]`, `rest = tokens[k+1..]`.
4. **Identifier anchor.** Else if `tokens[0]` matches FIGI/ISIN/CUSIP/OCC shape *and* passes its check
   digit: `security = tokens[0]`, `rest = tokens[1..]`.
5. **Formula anchor.** Else if `raw` contains `<…>`: `security = formula`, `rest` = tokens after `>`.
6. **Function-first.** If `rest` is now defined, `rest[0]` must be a function code/alias
   (else `problems: UNKNOWN_FUNCTION` and the security-only interpretation is returned instead).
   If no anchor was found, generate up to three interpretations:
   - **F**: `tokens[0]` is a function code, `args = tokens[1..]` — allowed when
     `registry.isFunctionToken(tokens[0])`.
   - **S**: `tokens[0..j]` is a ticker key without sector, followed by an optional function code at
     `j+1` — allowed when `env.isKnownTicker(tokens[0..j])` for the longest `j` (max 3 tokens, so
     `T 4.25 08/15/35` works) — the sector is filled in by the ranker (Equity → Index → Curncy → Govt).
   - **S+F**: `tokens[0]` ticker, `tokens[1]` function (`AAPL GP`).
7. Interpretations are ordered by the ranking rules (§2.4). The first is what GO executes; the
   others appear in the autocomplete list as alternatives (e.g. `Q` shows both "Q — Quote" and
   `Q US Equity` if such a ticker exists).
8. Args are mapped by `manifest.paramGrammar`: positional types parse tenors (`1Y`, `6M`, `10D`),
   ranges (`1D…MAX`, `YTD`), dates (`2024-01-15`, `01/15/24`, `15JAN24`), numbers, enums (case-
   insensitive unique prefix); keyed args `KEY=VALUE`; unknown args produce `ARG_PARSE` problems and
   are ignored (the function still launches with defaults, the footer shows the problem).

Context rules (TERM-03): `shape:'function'` → applies to the panel's current security (if the
function requires one and none is loaded → footer error `NO SECURITY LOADED`, autocomplete offers
SECF). `shape:'security'` → reloads the panel's current function with the new security (if the
panel is empty → DES). `security+function` → both.

### 2.3 Local universe index (`web/src/command/localIndex.ts`, structures in `core/command/index.ts`)

Built once from `/universe/snapshot` (≈ 38k instruments + 40 functions + people + topics), cached in
IndexedDB with the snapshot `version`; rebuilt in a Worker in < 300 ms.

| Structure | Purpose | Lookup |
| --- | --- | --- |
| `tickerSorted: Uint32Array` (indexes into `entries`, sorted by upper ticker) | prefix match on ticker | binary search lower/upper bound: O(log n) |
| `codeSorted` (functions + aliases) | prefix match on function code | binary search |
| `wordIndex: Map<string /*3-char prefix*/, Uint32Array>` | name word prefix (`APP` → APPLE INC, APPLE HOSPITALITY…) | map get + filter by full prefix |
| `trigrams: Map<string, Uint32Array>` (only for entries with popularity ≥ 20 or index members ≈ 6k) | fuzzy fallback (`APPL`, `MICROSFT`) | Jaccard over trigram sets, only when prefix hits < 5 and query ≥ 3 chars |
| `mru: Array<{ id; kind; lastUsed; count }>` (per user, localStorage + workspace) | recency boost | linear (≤ 50) |
| `people`, `topics` | small arrays | prefix on name/code |

### 2.4 Ranking (`core/command/rank.ts`)

Score every candidate `c` for query token `q` (upper-cased; only the token being completed is
scored, other tokens are already anchored):

```
score(c) = matchScore + kindPrior + popularity + recency + contextBoost - penalties

matchScore:  exact ticker/code = 100 | ticker prefix = 80 - 2·(len(ticker)-len(q)) (min 60)
             | function code prefix = 78 - 2·(len(code)-len(q)) | alias exact = 90 | alias prefix = 70
             | name word prefix (first word) = 60 | name word prefix (other word) = 50
             | trigram similarity s∈[0.4,1] = 40·s | none = −∞ (excluded)
kindPrior:   instrument 0 | function +6 if (panel has security ∧ q is function-shaped: 1–6 alnum) else −4
             | person −8 | topic −6 (topics only shown ≥ 2 chars)
popularity:  0..10 = snapshot popularity/10 (index membership, symbol-book presence, global launch counts)
recency:     +15·(1 − rank/20) for the 20 most recent MRU entries of this user (rank 0 = most recent), else 0
contextBoost:+8 if candidate is an instrument in the focused panel's watchlist/monitor
             +5 if function applicable to the panel's current asset class; −20 if not applicable
             +4 sector default when sector omitted: Equity +4, Index +3, Curncy +2, Govt +2, Crypto +1
penalties:   inactive/delisted −30 | option instruments −10 unless q contains '/' or 'C'/'P'+digits
             | Yahoo-fallback hits −25 (never above a local hit with matchScore ≥ 60)
tie-break:   shorter primary text, then alphabetical
```

Result list: top 12, at most 8 of one kind unless the others are empty; the first row is exactly
the interpretation GO will execute. Latency budget: ≤ 4 ms per keystroke on 38k entries (measured in
`command.bench.ts`), rendered in the same frame (< 16 ms, NFR).

### 2.5 Worked examples

| Input | Best interpretation | Alternatives shown |
| --- | --- | --- |
| `AAPL` (panel empty) | `AAPL US Equity` → DES | `AAPL` name matches (Apple Hospitality `APLE US Equity`), `AAPX US Equity` |
| `GP` (panel has AAPL) | function GP on AAPL | ticker `GP*` prefix hits (`GPC US Equity`) |
| `GP 1Y` | GP with `{range:'1Y'}` | — |
| `SPX` | `SPX Index` → current function or DES | `SPXL US Equity` … |
| `EURUSD` | `EURUSD Curncy` | — |
| `T 4.25 08/15/35` | `T 4.25 08/15/35 Govt` | — |
| `912797KL7 Govt YAS` | CUSIP (check digit ok) → YAS | — |
| `AAPL US 09/18/26 C330 Equity OVML` | option instrument → OVML | — |
| `<AAPL US Equity / MSFT US Equity> GP` | formula security → GP | — |
| `N tender offer` | N with `{query:'tender offer'}` | — |
| `HELP YAS` | help screen for YAS | — |
| `BBG000B9XRY4` | FIGI → AAPL US Equity | — |
| `MSFT GP` | `MSFT US Equity` + GP | — |

---

## 3. HELP and SECF semantics

### 3.1 HELP (TERM-09)

| Press | Behaviour |
| --- | --- |
| HELP key (F1) once, or `HELP <GO>` | Overlay (right third of the focused panel) generated from the current function's `help` manifest: summary, description, params with examples, keys, sources with licence attribution, related functions. Focus moves into the overlay (scrollable, `Esc` closes). Emits `function.help`. |
| HELP twice within 1.5 s, or HELP while the overlay is open | Ticket form (`POST /help/tickets`) pre-filled with function, security, params, trace id, and last error; user types the question; `GO` submits; confirmation shows ticket id. Emits `help.ticket`. There is no 24/7 desk (BRIEF non-goal); tickets are visible to `support` role at `HELP TICKETS`. |
| `HELP <CODE>` | Help for that function without launching it. |
| `HELP <text>` | Search over manifests (name/summary/description) and field dictionary, ranked by trigram similarity; Enter opens the help of the hit. |

### 3.2 SECF — Security Finder

`SECF [query]` opens a full-panel finder: query box (pre-filled from the command line), asset-class
tabs (`1` All, `2` Equity, `3` ETF, `4` Index, `5` Curncy, `6` Govt, `7` Option, `8` Rate/Econ,
`9` Crypto), result grid (key, name, type, exchange, currency, status, index membership), and a detail
strip for the focused row (identifiers, listings). Ranking uses §2.4 with `kinds:['instrument']`;
server `/search` is used when the local index has < 3 hits or a filter is set that the local index
cannot answer (exchange/country). `Enter` loads DES in the current panel; `Shift+Enter` loads it in
the next panel; `Ctrl+W` adds to the active watchlist.

---

## 4. Function manifests

Common conventions for the tables below: *Live* is the `live()` result; *Deps* lists tables
(DATA_MODEL.md) and providers (PROVIDERS.md); *Keys* are in addition to the global keymap
(CLIENT.md §4). All params objects also accept `asOf` (`{validAt?, knownAt?}`) via the shell.

### 4.1 Tier 1

#### DES — Security Description

| | |
| --- | --- |
| code / aliases | `DES` / `DESC` |
| tier / category | 1 / reference |
| assetClasses | equity, etf, index, fx, govt, option, crypto, rate, econ |
| variants | equity→`equity`, etf→`equity`, index→`index`, fx→`fx`, govt→`govt`, option→`option`, crypto→`crypto`, rate→`rate`, econ→`econ` |
| params | `z.object({ tab: z.enum(['profile','identifiers','stats','filings','members','terms']).default('profile') })` · grammar: positional `[tab?]` |
| fieldClasses | reference, quote, trade, ohlc, fundamental, holdings, news |
| live | `{subjects:['q:<iid>'], fields:['PX_LAST','CHG_NET_1D','CHG_PCT_1D','PX_BID','PX_ASK','PX_VOLUME','SESSION_STATE','STALE_TIER']}` |
| pageable | no |

```ts
export type DesPayload =
  | { variant: 'equity'; instrument: InstrumentDto; profile: { description: string | null; sicDesc: string | null; gicsSector: string | null; gicsSubIndustry: string | null; country: string | null; stateOfInc: string | null; fiscalYearEnd: string | null; website: string | null; category: string | null; exchange: string | null; listedSince: string | null };
      stats: { px: FieldValue; chg: FieldValue; chgPct: FieldValue; open: FieldValue; high: FieldValue; low: FieldValue; prevClose: FieldValue; volume: FieldValue; avgVolume30d: number | null; high52w: number | null; low52w: number | null; sharesOut: number | null; sharesOutAsOf: string | null; mktCap: number | null; peTtm: number | null; epsTtm: number | null; divYield: number | null; lastDiv: { exDate: string; amount: number } | null; nextEarnings: { date: string; estimated: boolean } | null; shortInterest: { qty: number; daysToCover: number; asOf: string } | null; iv30: number | null; beta1y: number | null };
      membership: Array<{ indexCode: string; weight: number | null; asOf: string }>;
      filings: Array<{ accn: string; form: string; filedAt: string; url: string; items: string[] }>;   // last 8
      news: Array<{ newsId: string; headline: string; publishedAt: string; source: string; url: string }>;   // last 6
      identifiers: Record<string, string>; listings: InstrumentDto['listings'] }
  | { variant: 'index'; instrument: InstrumentDto; level: FieldValue; chg: FieldValue; chgPct: FieldValue; high52w: number | null; low52w: number | null; provider: string; memberCount: number | null; membersAsOf: string | null; top10: Array<{ key: string; name: string; weight: number }>; returns: { d1: number | null; w1: number | null; m1: number | null; ytd: number | null; y1: number | null }; related: string[] }
  | { variant: 'fx'; instrument: InstrumentDto; base: string; quote: string; spot: FieldValue; chgPct: FieldValue; ecbRef: { rate: number; date: string } | null; high52w: number | null; low52w: number | null; inverse: number | null; crosses: Array<{ pair: string; rate: number | null }> }
  | { variant: 'govt'; instrument: InstrumentDto; terms: { cusip: string; secType: string; coupon: number | null; maturity: string; issueDate: string; datedDate: string | null; dayCount: string; freq: number; firstCoupon: string | null; benchmarkTenor: string | null; settlementDays: number }; pricing: { settlement: string; yield: number | null; price: number | null; accrued: number | null; modDuration: number | null; dv01: number | null; convexity: number | null; curveSource: string } }
  | { variant: 'option'; instrument: InstrumentDto; terms: { occ: string; underlyingKey: string; expiry: string; strike: number; putCall: 'C' | 'P'; style: string; multiplier: number; settlement: string; daysToExpiry: number }; market: { bid: number | null; ask: number | null; last: number | null; volume: number | null; oi: number | null; iv: number | null; delta: number | null; gamma: number | null; vega: number | null; theta: number | null; rho: number | null; theo: number | null; asOf: string }; underlying: { px: FieldValue; chgPct: FieldValue } }
  | { variant: 'crypto'; instrument: InstrumentDto; px: FieldValue; chg24hPct: FieldValue; source: string }
  | { variant: 'rate'; instrument: InstrumentDto; latest: { date: string; value: number; pct1: number | null; pct25: number | null; pct75: number | null; pct99: number | null; volumeBn: number | null; targetFrom: number | null; targetTo: number | null; revision: string | null }; history30: Array<[string, number]>; averages: { d30: number | null; d90: number | null; d180: number | null; index: number | null } | null; description: string }
  | { variant: 'econ'; instrument: InstrumentDto; series: { seriesId: string; name: string; units: string | null; frequency: string; seasonalAdj: string | null; source: string; country: string }; latest: { obsDate: string; value: number | null; vintage: string } | null; prior: { obsDate: string; value: number | null } | null; nextRelease: { at: string; timeKnown: boolean } | null; history24: Array<[string, number | null]> };
```

Deps: `instruments/issuers/issues/listings/identifiers`, `quote_ticks`/plant, `bars_1d`,
`xbrl_facts` (`dei:EntityCommonStockSharesOutstanding`, `EarningsPerShareDiluted` TTM), `corporate_actions`,
`index_memberships`, `short_interest`, `filings`, `news_entity_links`, `govt_terms`, `option_terms`,
`option_chain_snapshots`, `rates_observations`, `econ_series/observations/release_events`, `curve_points`.
Providers on miss: SEC submissions (6 h TTL), companyfacts (24 h), Cboe quote.

Screen: header strip (key · name · px · chg · chg% · session/stale badge · source) | left column
`kv` profile + identifiers | right column `kv` stats (live cells) | bottom split: membership badges,
filings `list`, news `list`. Tabs by number keys `1..6`. Enter on a filing opens the SEC URL; Enter
on news → `N` detail; `G` → GP, `Q` → Q, `F` → FA, `C` → CN (function hot-keys are shown in the
footer). CSV: `label,value,source,asOf` for every kv row (two-column export).

#### GP — Price Graph

| | |
| --- | --- |
| code / aliases | `GP` / `GRAPH`, `CHART` |
| tier / category | 1 / charting; screenKind custom (`PriceChart`) |
| assetClasses | equity, etf, index, fx, govt, option, crypto, rate, econ |
| params | see below · grammar: positional `[range?]`, keyed `TYPE=`, `ADJ=`, `VS=` (overlay security), `CCY=`, `NORM=` |
| fieldClasses | ohlc, trade, reference, derived, news |
| live | `{subjects:['q:<iid>', ...overlays], fields:['PX_LAST','PX_VOLUME','LAST_TRADE_TS']}` (chart appends last price to the forming bar) |

```ts
export const GpParams = z.object({
  range: z.enum(['1D','5D','1M','3M','6M','YTD','1Y','2Y','5Y','10Y','MAX','CUSTOM']).default('1Y'),
  start: z.iso.date().optional(), end: z.iso.date().optional(),
  periodicity: z.enum(['auto','1m','5m','15m','1h','D','W','M']).default('auto'),
  type: z.enum(['line','candle','ohlc','bar','area','mountain','pnf','profile','heatmap','tick']).default('line'),
  adjust: AdjustPolicy.default('price'),
  overlays: z.array(SecurityRef).max(5).default([]),
  normalise: z.enum(['none','pct','base100']).default('none'),
  currency: z.string().length(3).optional(),
  studies: z.array(z.object({ id: z.string(), params: z.record(z.string(), z.number()).default({}), pane: z.enum(['main','sub']).default('sub') })).default([]),
  events: z.object({ earnings: z.boolean().default(true), dividends: z.boolean().default(true), splits: z.boolean().default(true), news: z.boolean().default(false), filings: z.boolean().default(false), indexChanges: z.boolean().default(true) }).default({}),
  logScale: z.boolean().default(false),
});
export interface GpPayload {
  series: Array<{ ref: SecurityRef; instrument: InstrumentDto; key: string; currency: string; bars: Bar[]; adjust: AdjustPolicy; periodicity: string; calendarId: string; provIdx: number }>;
  events: Array<{ t: number; kind: 'earnings' | 'dividend' | 'split' | 'news' | 'filing' | 'index_add' | 'index_drop'; label: string; command: string; provIdx: number }>;   // click-through command (CHRT-06)
  annotations: Array<{ id: string; kind: string; anchors: Array<{ t: number; v: number }>; style: Record<string, unknown>; text?: string; ownerId: string; shared: boolean }>;
  fx: Array<{ base: string; quote: string; points: Array<[number, number]> }>;   // when currency conversion requested
  session: { calendarId: string; tz: string };
}
```

Deps: `bars_1d`, `bars_1m`, `corporate_actions`, `filings` (10-Q/10-K/8-K item 2.02 = earnings),
`news_entity_links`, `index_memberships` (adds/drops), `fx_rates`, `chart_annotations`,
`calendar_holidays`. Studies are computed client-side in `chart/engine/studies` from the payload
(same TS code as the server's `core/analytics/stats` where overlapping; golden-tested).
Screen: chart fills the panel; range selector row (`1D 5D 1M 3M 6M YTD 1Y 2Y 5Y 10Y MAX`),
type/adjust/normalise badges. Keys: `←/→` move crosshair by bar, `Shift+←/→` pan, `+/-` zoom,
`Home/End` extremes, `T` cycle type, `A` cycle adjust, `L` log, `S` open study picker (typeahead over
~100 studies), `O` overlay picker (security prompt), `E` toggle event markers, `D` draw mode
(trendline/hline/fib/text — anchors typed or arrow-placed), `Enter` on an event marker → its
command, `Ctrl+S` save annotations, `N` normalise cycle. CSV: `t,security,open,high,low,close,volume,adjClose`
per series plus study columns (`ma_20`, `rsi_14` …) as rendered.

#### GIP — Intraday Price Graph

| | |
| --- | --- |
| code / aliases | `GIP` / `INTRA` |
| tier / category | 1 / charting; custom (`PriceChart` intraday mode) |
| assetClasses | equity, etf, index, fx, crypto, option |
| params | `z.object({ days: z.enum(['1','2','5']).default('1'), interval: z.enum(['1m','5m']).default('1m'), session: z.enum(['regular','extended']).default('regular'), vwap: z.boolean().default(true), prevClose: z.boolean().default(true) })` · grammar positional `[days?]` |
| fieldClasses | ohlc, trade |
| live | `{subjects:['bar1m:<iid>','q:<iid>'], fields:'*'}` |

Payload: `{ bars: Bar[]; sessions: Array<{ start: number; end: number; kind: 'pre'|'regular'|'post' }>; prevClose: number | null; vwap: Array<[number, number]>; tz: string; forming: Bar | null }`.
Deps: `bars_1m`, `quote_ticks`; provider Yahoo chart `range=1d&interval=1m` (60 s TTL while
subscribed). Screen: chart + volume sub-pane + stats strip (open, high, low, last, VWAP, volume, %
of 30-d avg). Keys as GP; `V` toggles VWAP. CSV: `t,open,high,low,close,volume,vwap`.

#### HP — Historical Price Table

| | |
| --- | --- |
| code / aliases | `HP` / `HIST` |
| tier / category | 1 / pricing |
| assetClasses | any except option (option history not available) |
| params | `z.object({ start: z.iso.date().optional(), end: z.iso.date().optional(), range: z.enum(['1M','3M','6M','YTD','1Y','2Y','5Y','10Y','MAX']).default('1Y'), periodicity: z.enum(['D','W','M','Q','Y']).default('D'), adjust: AdjustPolicy.default('price'), currency: z.string().length(3).optional(), fields: z.array(z.enum(['PX_OPEN','PX_HIGH','PX_LOW','PX_LAST','PX_VOLUME','CHG_NET_1D','CHG_PCT_1D','PX_VWAP_1D'])).default(['PX_LAST','PX_OPEN','PX_HIGH','PX_LOW','PX_VOLUME','CHG_PCT_1D']), pageSize: z.number().int().min(20).max(500).default(60) })` · grammar positional `[range|start, end?, periodicity?]`, keyed `ADJ=` |
| fieldClasses | ohlc, trade |
| pageable | yes (PAGE FWD = older) |

Payload: `{ rows: Array<{ date: string; values: Record<string, number | null>; adjFactor: number }>; summary: { first: number | null; last: number | null; high: number | null; low: number | null; totalReturnPct: number | null; priceReturnPct: number | null; bars: number }; adjust: AdjustPolicy; currency: string; provIdx: number }`.
Deps: `bars_1d` (+ `adjustment_factors`), `fx_rates`, `calendar_holidays` for periodicity roll-ups.
Screen: header (range, adjust, ccy badges) | `grid` (date column frozen) | summary strip. Keys: `A`
cycle adjust, `P` cycle periodicity, `PageUp/PageDown` pages, `Enter` on a row → GP centred on that
date. CSV: `date,` + selected field ids + `adj_factor`.

#### Q — Quote

| | |
| --- | --- |
| code / aliases | `Q` / `QUOTE`, `QR` |
| tier / category | 1 / pricing |
| assetClasses | equity, etf, index, fx, option, crypto |
| params | `z.object({ depth: z.number().int().min(1).max(10).default(5) })` |
| fieldClasses | quote, trade, ohlc |
| live | `{subjects:['q:<iid>'], fields:'*', conflateMs: 100}` |

Payload: `{ instrument: InstrumentDto; composite: Record<string, FieldValue>; lines: Array<{ lineId: string; source: string; tier: LatencyTier; symbol: string; fields: Record<string, FieldValue>; ts: Timestamps; stale: StalenessTier }>; book: { bids: Array<{ px: number; size: number; venue: string }>; asks: Array<{ px: number; size: number; venue: string }>; depthAvailable: number }; session: { state: SessionState; calendarId: string; open: string; close: string; tz: string }; timestamps: Timestamps; compositionRule: string }`.
Deps: plant, `md_lines`, `quote_ticks` (last 20 prints for the tape). Screen: big last/chg cells
(live, flash), bid/ask ladder (top-of-book from Cboe; depth slots rendered empty with reason
`DEPTH_UNAVAILABLE_SOURCE`), OHLC/prev-close/volume kv, per-line table (Cboe, Yahoo) with each
line's three timestamps, tape list. Keys: `Enter` on a line → shows its provenance; `G` → GIP.
CSV: `field,composite,cboe,yahoo,src_ts,cap_ts,pub_ts,stale`.

#### QM — Quote Monitor

| | |
| --- | --- |
| code / aliases | `QM` / `MON` |
| tier / category | 1 / monitor |
| assetClasses | none (list-driven) |
| params | `z.object({ source: z.discriminatedUnion('kind', [z.object({ kind: z.literal('watchlist'), id: z.string() }), z.object({ kind: z.literal('index'), code: z.string() }), z.object({ kind: z.literal('keys'), keys: z.array(z.string()).max(500) })]).default({ kind: 'watchlist', id: 'default' }), columns: z.array(z.string()).default(['PX_LAST','CHG_NET_1D','CHG_PCT_1D','PX_BID','PX_ASK','BID_SIZE','ASK_SIZE','PX_VOLUME','PX_HIGH','PX_LOW','LAST_TRADE_TS','STALE_TIER']), sort: z.object({ col: z.string(), dir: z.enum(['asc','desc']) }).optional(), groupBy: z.enum(['GICS_SECTOR','EXCH_CODE','ASSET_CLASS']).optional() })` · grammar positional `[watchlist|index]` |
| fieldClasses | quote, trade, ohlc, reference |
| live | `{subjects: rows.map(r => 'q:'+r.iid), fields: columns}` |

Payload: `{ rows: Array<{ iid: string; key: string; name: string; assetClass: AssetClass; gicsSector: string | null; exchCode: string | null; snapshot: Record<string, FieldValue> }>; columns: string[]; title: string }`.
Deps: `watchlists`, `index_memberships`, `instrument_classifications`, plant. Screen: `grid` with
`live.subjectOf`, sort/group, frozen key column. Keys: `S` sort by focused column (toggle), `G`
cycle group-by, `C` column picker (typeahead over field dictionary), `Enter` → DES of row,
`Shift+Enter` → DES in next panel, `Insert` add security (prompt), `Delete` remove (keys mode only).
CSV: `key,name,` + columns (values as displayed at export time from the cached payload + latest
plant snapshot reproduced server-side).

#### W — Watchlists

| | |
| --- | --- |
| code / aliases | `W` / `WL`, `WATCH` |
| tier / category | 1 / monitor |
| assetClasses | none |
| params | `z.object({ watchlistId: z.string().optional(), name: z.string().optional(), view: z.enum(['grid','manage']).default('grid') })` · grammar positional `[name?]` |
| fieldClasses | quote, trade, ohlc, reference, derived |
| live | same as QM over items |

Payload: `{ watchlists: Array<{ id: string; name: string; owner: string; shared: string; count: number }>; active: { id: string; name: string; columns: Array<{ id: string; label: string; formula?: string; type: 'field' | 'formula' }>; rows: Array<{ pos: number; iid: string | null; key: string; name: string; formula?: string; snapshot: Record<string, FieldValue>; computed: Record<string, number | null> }> } | null }`.
Computed columns: formulas over field ids (`PX_LAST/PX_PREV_CLOSE-1`, `PX_LAST*SHARES_OUT`) evaluated
by `core/formula` client-side on every delta (server evaluates once for CSV). Deps: `watchlists`,
`watchlist_items`, plant, `xbrl_facts` for reference fields. Screen: left list of watchlists (`Tab`
to focus) | grid. Keys: `Insert` add row (security prompt with autocomplete), `Delete` remove,
`Alt+↑/↓` reorder, `F` add formula column (prompt), `Ctrl+S` save (also autosaves), `R` rename, `Ctrl+N`
new list, `Ctrl+Shift+S` share (firm/users). CSV: `pos,key,name,` + columns.

#### TOP — Top News

| | |
| --- | --- |
| code / aliases | `TOP` / `TOPN` |
| tier / category | 1 / news |
| assetClasses | none |
| params | `z.object({ topic: z.enum(['ALL','MARKETS','ECONOMICS','POLITICS','TECHNOLOGY','WEALTH','INDUSTRIES','FED','SEC8K']).default('ALL'), pageSize: z.number().int().default(40) })` · grammar positional `[topic?]` |
| fieldClasses | news |
| live | `{subjects:['news:'+topic], fields:'*'}` (new headlines prepend, flash) |
| pageable | yes |

Payload: `{ items: Array<{ newsId: string; headline: string; summary: string | null; source: string; author: string | null; publishedAt: string; capturedAt: string; url: string; topics: string[]; links: Array<{ kind: string; id: string; key: string; confidence: number }>; isCorrection: boolean }>; topic: string; asOf: string }`.
Deps: `news_items`, `news_entity_links`, `news_topics`; providers Bloomberg RSS (60 s), Fed RSS
(300 s), SEC 8-K atom (60 s). Screen: dense `list` (time · source · headline · linked keys as badges);
number keys switch topic tabs. Keys: `Enter` → story detail (summary, links, open URL with `O`),
`Ctrl+Enter` → DES of first linked security in next panel, `L` filter to linked securities in the
active watchlist, `PageUp/PageDown`. CSV: `publishedAt,source,headline,url,linkedKeys`.

#### N — News Search

| | |
| --- | --- |
| code / aliases | `N` / `NEWS` |
| tier / category | 1 / news |
| assetClasses | any (optional security narrows) |
| requiresSecurity | no |
| params | `z.object({ query: z.string().max(200).default(''), topic: z.string().optional(), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), sources: z.array(z.string()).optional(), sort: z.enum(['time','relevance']).default('time'), pageSize: z.number().int().default(40) })` · grammar `rest: query` |
| fieldClasses | news |
| pageable | yes |

Payload: `{ items: TopPayload['items'] & { rank: number; snippet: string }[]; total: number; query: string; securityKey: string | null }`.
Deps: `news_items` (`fts @@ websearch_to_tsquery`, ranked with `ts_rank_cd` + recency decay; trigram
on headline for typos), `news_entity_links`. Screen: query input (focused) | results list | detail.
Keys: `/` focus query, `Enter` open, `S` sort toggle, `Ctrl+S` save search (`saved_searches`), `A`
create alert from query. CSV: as TOP plus `rank`.

#### NI — News by Topic Code

`NI <TOPIC>` (aliases `NEWSI`): same payload/screen as TOP with `params.topic` required and a
topic browser (`NI` alone lists `news_topics` with counts for 24 h). Grammar positional `[topic]`
(type `topic`, autocomplete against topics). CSV as TOP.

#### MSG — Messaging (alias IB)

| | |
| --- | --- |
| code / aliases | `MSG` / `IB`, `CHAT` |
| tier / category | 1 / messaging |
| assetClasses | none |
| params | `z.object({ roomId: z.string().optional(), to: z.string().optional() /* user id or email */, view: z.enum(['inbox','room','directory']).default('inbox') })` · grammar positional `[person?]` (type `string`, autocomplete kind person) |
| fieldClasses | — |
| live | `{subjects: ['room:'+roomId] or all rooms in inbox, fields:'*'}` |
| pageable | yes (older messages) |

Payload: `{ rooms: Array<{ roomId: string; kind: string; name: string; members: Array<{ userId: string; name: string; firm: string; desk: string | null }>; unread: number; lastAt: string | null; disclaimer: string | null }>; room: { roomId: string; messages: Array<{ id: string; seq: number; sender: { userId: string; name: string; firm: string }; sentAt: string; body: string; attachments: Attachment[]; hash: string }>; policy: { retentionDays: number; counterpartiesAllowed: boolean; disclaimer: string | null } } | null; directory: Array<{ userId: string; name: string; firm: string; desk: string | null; role: string }> }`.
`Attachment = { kind: 'security'; key: string } | { kind: 'function'; code: string; securityKey: string | null; params: unknown; resultId?: string } | { kind: 'chart'; securityKey: string; params: unknown; annotationIds: string[] } | { kind: 'portfolio'; portfolioId: string }`.
Deps: `rooms`, `room_members`, `messages`, `users`, `firms.policy`, `surveillance_lexicon`.
Screen: left rooms list | thread (`list`, newest at bottom) | composer (single-line input; `Ctrl+Enter`
newline). Keys: `Tab` cycle rooms/thread/composer, `Enter` send, `Alt+S` attach the *other* panel's
current function (renders live for the recipient within *their* entitlements — server re-runs the
function for the viewer, MSG-04), `Alt+W` attach security, `Enter` on an attachment → launches it in
the next panel, `Ctrl+N` new room (directory picker), `Ctrl+F` search thread. Policy violations show
inline (`POLICY_BLOCKED: counterparty not permitted`). CSV: `sentAt,room,sender,firm,body,attachments,hash` (compliance export, role-gated).

#### WEI — World Equity Indices

| | |
| --- | --- |
| code / aliases | `WEI` / `INDICES` |
| tier / category | 1 / monitor |
| assetClasses | none |
| params | `z.object({ region: z.enum(['ALL','AMER','EMEA','APAC']).default('ALL'), columns: z.array(z.string()).default(['PX_LAST','CHG_NET_1D','CHG_PCT_1D','RET_1W','RET_YTD','RET_1Y','PX_HIGH','PX_LOW','LOCAL_TIME','SESSION_STATE']) })` · grammar positional `[region?]` |
| fieldClasses | quote, ohlc, derived |
| live | `{subjects: indices.map(i => 'q:'+i.iid), fields: ['PX_LAST','CHG_NET_1D','CHG_PCT_1D','PX_HIGH','PX_LOW','SESSION_STATE','STALE_TIER']}` |

Payload: `{ groups: Array<{ region: 'AMER' | 'EMEA' | 'APAC'; rows: Array<{ iid: string; key: string; name: string; currency: string; tz: string; snapshot: Record<string, FieldValue>; returns: { w1: number | null; m1: number | null; ytd: number | null; y1: number | null }; sparkline: number[]; source: string; tier: LatencyTier }> }>; asOf: string }`.
Index set (seed): AMER `SPX, INDU, CCMP, RTY, VIX, SPTSX, IBOV`; EMEA `UKX, DAX, CAC, SX5E, BUK100P, SMI, IBEX`;
APAC `NKY, HSI, SHCOMP, AS51, KOSPI, NIFTY`. Sources: Cboe (`_SPX`, `_VIX`), Cboe Europe
(`BUK100P`), Yahoo (`^GSPC ^DJI ^IXIC ^RUT ^GSPTSE ^BVSP ^FTSE ^GDAXI ^FCHI ^STOXX50E ^SSMI ^IBEX
^N225 ^HSI 000001.SS ^AXJO ^KS11 ^NSEI`). Deps: `bars_1d` for returns, plant. Screen: three grouped
grids (group headers = region), local time column ticks each second, session badge. Keys: `1..4`
region filter, `Enter` → DES, `G` → GP of focused index, `M` → MEMB. CSV: `region,key,name,` + columns + returns.

#### HELP — Help

| | |
| --- | --- |
| code / aliases | `HELP` / `H` |
| tier / category | 1 / system · assetClasses none · not pageable |
| params | `z.object({ code: z.string().optional(), query: z.string().optional(), ticket: z.boolean().default(false) })` · grammar positional `[code?]`, rest `query` |

Payload: `{ mode: 'function' | 'search' | 'ticket'; function?: { code: string; name: string; tier: Tier; help: HelpSpec; params: Array<{ name: string; schema: unknown; default: unknown }>; csvColumns: CsvColumn[]; attribution: string[] }; hits?: Array<{ kind: 'function' | 'field' | 'topic'; id: string; title: string; snippet: string }>; ticket?: { prefill: { functionCode: string | null; securityKey: string | null; params: unknown; traceId: string; lastError: string | null } } }`.
Deps: registry, field dictionary, `help_tickets`. Screen/keys: §3.1. CSV: `section,key,text`.

#### SECF — Security Finder

| | |
| --- | --- |
| code / aliases | `SECF` / `SF`, `FIND` |
| tier / category | 1 / reference · assetClasses none · pageable |
| params | `z.object({ query: z.string().default(''), assetClass: AssetClass.optional(), sector: MarketSector.optional(), exchange: z.string().optional(), country: z.string().optional(), status: z.enum(['active','all']).default('active'), pageSize: z.number().int().default(50) })` · grammar rest `query`, keyed `AC=`, `EXCH=` |
| fieldClasses | reference |

Payload: `{ hits: Array<SearchHit & { instrument: InstrumentDto; memberOf: string[] }>; total: number; facets: { assetClass: Record<string, number>; exchange: Record<string, number> } }`.
Deps: local index / `/search`, `instruments`, `listings`, `identifiers`, `index_memberships`. Screen/keys: §3.2. CSV: `key,name,assetClass,exchange,currency,figi,isin,cusip,status,memberOf`.

### 4.2 Tier 2

#### FA — Financial Analysis

| | |
| --- | --- |
| code / aliases | `FA` / `FIN` · tier 2 · fundamentals · assetClasses equity, etf(→ 'NOT_APPLICABLE_FUND' notice) |
| params | `z.object({ statement: z.enum(['IS','BS','CF','RATIOS','PER_SHARE','SEGMENTS']).default('IS'), periodType: z.enum(['Q','FY','TTM']).default('FY'), periods: z.number().int().min(2).max(16).default(8), asReported: z.boolean().default(false), currency: z.string().length(3).default('USD'), scale: z.enum(['1','1e3','1e6','1e9']).default('1e6') })` · grammar positional `[statement?, periodType?]`, keyed `AR=1` |
| fieldClasses | fundamental |

Payload: `{ issuer: { issuerId: string; name: string; cik: number; fiscalYearEnd: string }; columns: Array<{ periodEnd: string; fy: number; fp: string; filedAt: string; accn: string; form: string; restated: boolean }>; rows: Array<{ lineItem: string; label: string; indent: number; values: Array<number | null>; unit: string; asReportedConcept: string | null; provIdx: number[] }>; knownAt: string; mappingVersion: string; notes: string[] }`.
Deps: `fundamentals_std`, `xbrl_facts`, `filings`, `concept_map`; provider SEC companyfacts (24 h
TTL on miss). PIT: columns are built from facts with `filed_at ≤ knownAt` (STOR-06). `SEGMENTS`
returns `rows: []` with note `SEGMENTS_UNAVAILABLE_NO_DIMENSIONAL_FACTS` (companyfacts has no
dimensional data). Screen: statement tabs (`1..6`) | `grid` (line items × periods, frozen label column,
restated columns marked `R`) | footer with mapping version and knownAt. Keys: `P` period type, `R`
as-reported toggle, `K` set knownAt (date prompt), `Enter` on a cell → shows the XBRL fact(s) and
filing link, `+/-` more/fewer periods. CSV: `lineItem,label,unit,` + one column per period end.

#### EE — Earnings (SEC actuals; estimates unavailable)

| | |
| --- | --- |
| code / aliases | `EE` / `ERN` · tier 2 · fundamentals · assetClasses equity |
| params | `z.object({ periods: z.number().int().min(4).max(24).default(12), metric: z.enum(['EPS_DILUTED','EPS_BASIC','REVENUE','NET_INCOME']).default('EPS_DILUTED') })` |
| fieldClasses | fundamental |

Payload: `{ history: Array<{ periodEnd: string; fy: number; fp: string; actual: number | null; filedAt: string; reportTiming: 'pre' | 'post' | 'unknown'; accn: string; yoyPct: number | null; estimate: null; surprise: null; estimateReason: 'NO_ESTIMATES_SOURCE' }>; next: { expectedDate: string; window: [string, string]; method: 'cadence' | 'prior_year' ; confidence: number } | null; consensus: { value: null; reason: 'NO_ESTIMATES_SOURCE' }; ttm: number | null; growth: { q: number | null; y: number | null } }`.
Deps: `xbrl_facts` (metric concept map), `filings` (10-Q/10-K and 8-K item 2.02 acceptance times →
report timing), `fomc`-style calendar not used. Screen: `grid` history (period, actual, yoy, filed,
estimate column rendered as `—` with reason tooltip `NO_ESTIMATES_SOURCE`) | next-expected kv |
sparkline. Keys: `M` metric cycle, `Enter` → filing. CSV: `periodEnd,fy,fp,actual,yoyPct,filedAt,accn,estimate,estimateReason`.

#### EQS — Equity Screening

| | |
| --- | --- |
| code / aliases | `EQS` / `SCREEN` · tier 2 · screening · assetClasses none · pageable |
| params | `z.object({ screenId: z.string().optional(), universe: z.enum(['SPX','ALL_US','ETF']).default('SPX'), criteria: z.array(z.object({ field: z.string(), op: z.enum(['>','>=','<','<=','=','!=','in','between','top','bottom']), value: z.union([z.number(), z.string(), z.array(z.union([z.number(), z.string()]))]) })).default([]), columns: z.array(z.string()).default(['PX_LAST','CHG_PCT_1D','MKT_CAP','PE_TTM','GICS_SECTOR']), sort: z.object({ col: z.string(), dir: z.enum(['asc','desc']) }).default({ col: 'MKT_CAP', dir: 'desc' }), pageSize: z.number().int().default(100) })` |
| fieldClasses | reference, fundamental, ohlc, derived |

Screenable fields: `MKT_CAP, PX_LAST, CHG_PCT_1D, RET_1M, RET_3M, RET_YTD, RET_1Y, VOL_30D_AVG, HIGH_52W_PCT, PE_TTM, PX_TO_BOOK, PX_TO_SALES, EV_TO_EBITDA, DIV_YIELD, SALES_REV_TURN, NET_INCOME, TOT_ASSETS, ROE, NET_MARGIN, REV_GROWTH_YOY, GICS_SECTOR, GICS_SUB_INDUSTRY, EXCH_CODE, IDX_MEMBER_SPX, SHORT_INT_DAYS_TO_COVER`.
Payload: `{ rows: Array<{ iid: string; key: string; name: string; values: Record<string, number | string | null> }>; total: number; criteria: EqsParams['criteria']; universeSize: number; asOf: { prices: string; fundamentals: string } }`.
Deps: `instruments`, `index_memberships`, `instrument_classifications`, `bars_1d` (derived returns
computed nightly into `screen_factors` materialised view refreshed by job `screen.factors`),
`xbrl_facts` frames (`sec-frames` CY-latest for `Assets`, `Revenues`, `NetIncomeLoss`,
`StockholdersEquity`), `short_interest`. Screen: criteria editor (`form` rows: field typeahead, op,
value) | results grid | save/load bar. Keys: `Ctrl+Enter` run, `Insert` add criterion, `Delete`
remove, `Ctrl+S` save (`saved_screens`), `L` load, `Enter` → DES. CSV: `key,name,` + columns.

#### RV — Relative Valuation

| | |
| --- | --- |
| code / aliases | `RV` / `COMP`, `PEERS` · tier 2 · fundamentals · assetClasses equity |
| params | `z.object({ peers: z.enum(['sub_industry','sector','custom']).default('sub_industry'), customKeys: z.array(z.string()).max(30).default([]), metrics: z.array(z.string()).default(['MKT_CAP','PE_TTM','EV_TO_EBITDA','PX_TO_BOOK','PX_TO_SALES','NET_MARGIN','REV_GROWTH_YOY','ROE','RET_1Y']) })` |
| fieldClasses | fundamental, reference, ohlc, derived |

Payload: `{ subject: RvRow; peers: RvRow[]; stats: { median: Record<string, number | null>; mean: Record<string, number | null>; percentileOfSubject: Record<string, number | null> }; peerBasis: string }` with `RvRow = { iid: string; key: string; name: string; gicsSubIndustry: string | null; values: Record<string, number | null>; asOf: Record<string, string> }`.
Deps: as EQS + `instrument_classifications`. Screen: subject row pinned | peers grid | stats rows.
Keys: `P` peer basis, `Insert` add peer, `M` metric picker, `Enter` → DES, `G` → GP overlay of subject vs
focused peer (`normalise:'base100'`). CSV: `key,name,` + metrics + `median,mean` rows appended.

#### CN — Company News

`CN` (aliases `CNEWS`): `N` restricted to `news_entity_links` of the loaded instrument's issuer
(links by CIK from SEC 8-K feed, ticker/name from Bloomberg RSS, confidence ≥ 0.8), including
Form 8-K/4 filings as pseudo-headlines (`source:'sec'`). Params: `z.object({ includeFilings: z.boolean().default(true), days: z.number().int().default(90), pageSize: z.number().int().default(40) })`.
Live `news:i:<iid>`. Payload/screen/CSV as N plus `filing` badges. Keys: `F` toggle filings.

#### CACS — Corporate Actions Calendar

| | |
| --- | --- |
| code / aliases | `CACS` / `CA`, `ACTIONS` · tier 2 · reference · assetClasses equity, etf, index(→ members' actions) |
| params | `z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), range: z.enum(['1Y','3Y','5Y','MAX','FWD']).default('3Y'), types: z.array(z.string()).default(['cash_dividend','special_dividend','split','reverse_split','spinoff','name_change','ticker_change','earnings']) })` |
| fieldClasses | reference, fundamental |

Payload: `{ events: Array<{ caId: string | null; type: string; status: 'estimated' | 'announced' | 'confirmed' | 'applied'; exDate: string | null; recordDate: string | null; payDate: string | null; declaredDate: string | null; amount: number | null; currency: string | null; ratio: string | null; description: string; source: string; provIdx: number; knownAt: string }>; next: { type: string; date: string; estimated: boolean } | null }`.
Deps: `corporate_actions` (Yahoo `events.dividends/splits` → `confirmed` on/after ex-date,
`announced` before), `filings` (8-K item 2.02 → earnings `confirmed`; projected next earnings →
`estimated` from EE cadence), `issuers.formerNames` (name changes). Screen: timeline `grid` (date ·
type · status badge · amount/ratio · declared/record/pay) with future rows highlighted. Keys: `T`
type filter, `Enter` → provenance/filing, `A` toggle adjust preview (shows resulting price factor).
CSV: `type,status,exDate,recordDate,payDate,declaredDate,amount,currency,ratio,description,source`.

#### CF — Company Filings

| | |
| --- | --- |
| code / aliases | `CF` / `FILINGS` · tier 2 · fundamentals · assetClasses equity, etf · pageable |
| params | `z.object({ forms: z.array(z.string()).default(['10-K','10-Q','8-K','DEF 14A','4','SC 13G','SCHEDULE 13G','S-3ASR','424B2']), from: z.iso.date().optional(), to: z.iso.date().optional(), xbrlOnly: z.boolean().default(false), pageSize: z.number().int().default(50) })` · grammar positional `[form?]` |
| fieldClasses | fundamental |

Payload: `{ filings: Array<{ accn: string; form: string; filedAt: string; reportDate: string | null; acceptedAt: string | null; items: string[]; primaryDoc: string | null; description: string | null; url: string; indexUrl: string; sizeBytes: number | null; isXbrl: boolean }>; total: number; cik: number }`.
Deps: `filings`; provider SEC submissions (6 h TTL). Screen: form filter chips | grid. Keys: `O`
open in browser, `X` XBRL-only, `Enter` → detail (items text, links), `F` form picker. CSV:
`accn,form,filedAt,reportDate,acceptedAt,items,primaryDoc,url`.

#### ECO — Economic Calendar

| | |
| --- | --- |
| code / aliases | `ECO` / `CAL`, `CALENDAR` · tier 2 · monitor · assetClasses none · pageable (week) |
| params | `z.object({ country: z.enum(['US','ALL']).default('US'), week: z.iso.date().optional() /* any date in the week */, importance: z.number().int().min(1).max(3).default(1), view: z.enum(['week','day','release']).default('week') })` · grammar positional `[country?]` |
| fieldClasses | econ |
| live | `{subjects:['news:ECON_RELEASES'], fields:'*'}` (release actuals push as news) |

Payload: `{ days: Array<{ date: string; events: Array<{ eventId: string; at: string; timeKnown: boolean; release: string; period: string | null; seriesId: string | null; seriesKey: string | null; importance: number; actual: number | null; prior: number | null; revisedPrior: number | null; consensus: null; consensusReason: 'NO_CONSENSUS_SOURCE'; status: string; units: string | null; source: string }> }>; week: { start: string; end: string }; fomc: Array<{ date: string; statementAt: string | null; hasSep: boolean }> }`.
Deps: `econ_release_events`, `econ_releases`, `econ_series`, `econ_observations`, `fomc_meetings`;
providers BLS schedule (monthly), FRED calendar (daily), FRED series CSV (after release).
Screen: week grid (day headers, rows = events with time, importance dots, actual/prior/revised;
consensus column rendered `—` with reason). Keys: `PageUp/PageDown` prev/next week, `T` today, `I`
importance cycle, `Enter` → DES of series (econ variant), `G` → GP of the series, `A` alert on event.
CSV: `date,time,release,period,seriesKey,actual,prior,revisedPrior,consensus,consensusReason,importance,source`.

#### PORT — Portfolio Analytics

| | |
| --- | --- |
| code / aliases | `PORT` / `PRT` · tier 2 · portfolio · assetClasses none |
| params | `z.object({ portfolioId: z.string().optional(), asOf: z.iso.date().optional(), benchmark: z.string().default('SPX'), view: z.enum(['holdings','attribution','exposure','risk','scenario','recon']).default('holdings'), horizonDays: z.number().int().default(252), scenario: z.object({ equityShockPct: z.number().default(-10), curveShiftBp: z.number().default(50), fxShockPct: z.number().default(0), episode: z.enum(['none','2020-03','2022-rates','2008-10']).default('none') }).default({}) })` · grammar positional `[portfolio?, view?]` |
| fieldClasses | quote, ohlc, reference, holdings, derived |
| live | holdings view: `q:` of positions |

Payload: `{ portfolio: { id: string; name: string; baseCurrency: string; asOf: string; benchmark: string; nav: number; cash: number }; holdings: Array<{ iid: string | null; key: string; name: string; qty: number; px: FieldValue; value: number; weight: number; benchWeight: number | null; activeWeight: number | null; costBasis: number | null; pnl: number | null; gicsSector: string | null; currency: string; reconStatus: string }>; attribution: { period: [string, string]; total: { portfolio: number; benchmark: number; active: number }; sectors: Array<{ sector: string; allocation: number; selection: number; interaction: number; total: number; wP: number; wB: number; rP: number; rB: number }>; method: 'Brinson-Fachler' } | null; exposure: { sectors: Array<{ sector: string; wP: number; wB: number; active: number }>; currencies: Array<{ ccy: string; w: number }>; top10: number; assetClasses: Record<string, number> } | null; risk: { trackingErrorAnn: number; volAnn: number; benchVolAnn: number; beta: number; corr: number; contributions: Array<{ key: string; mctr: number; cctr: number; weight: number }>; method: 'historical covariance 252d'; var: { h95: number; h99: number; p95: number; p99: number; horizonDays: number; exceptions252d: number } } | null; scenario: { pnl: number; pnlPct: number; byHolding: Array<{ key: string; pnl: number }>; assumptions: Record<string, number | string> } | null; recon: { rowsOk: number; rowsError: number; errors: Array<{ identifier: string; reason: string }> } | null }`.
Deps: `portfolios`, `positions`, `lots`, `bars_1d`, `index_memberships`, `instrument_classifications`,
`fx_rates`; engines `core/analytics/portfolio/*` and `stats`. RLS-enforced. Screen: view tabs (`1..6`)
| grid or kv sections. Keys: `U` upload (file picker → `/portfolios/{id}/positions`), `B` benchmark
prompt, `S` scenario form, `Enter` → DES. CSV per view: holdings `key,name,qty,px,value,weight,benchWeight,activeWeight,pnl,sector`;
attribution `sector,wP,wB,rP,rB,allocation,selection,interaction,total`; risk `key,weight,mctr,cctr`.

#### HDS — Holders (ETF holders; 13F not feasible)

| | |
| --- | --- |
| code / aliases | `HDS` / `HOLD`, `HOLDERS` · tier 2 · fundamentals · assetClasses equity, etf(→ its holdings) |
| params | `z.object({ view: z.enum(['etf_holders','insiders','holdings']).default('etf_holders'), asOf: z.iso.date().optional() })` |
| fieldClasses | holdings, fundamental |

Payload: `{ view: string; etfHolders: Array<{ etfKey: string; etfName: string; shares: number | null; value: number | null; weight: number | null; asOf: string; source: 'sec_nport' | 'ssga'; provIdx: number }>; insiders: Array<{ accn: string; form: '4' | '3' | '5' | '144'; filedAt: string; reporter: string | null; url: string }>; holdings: Array<{ key: string; name: string; weight: number; shares: number | null; value: number | null; assetCat: string | null }> | null; note: '13F_NOT_AVAILABLE_NO_FULL_TEXT_SEARCH' }`.
Deps: `etf_holdings`, `filings` (forms 3/4/5/144 by CIK), providers SEC N-PORT (quarterly), SSGA
(daily). Screen: view tabs | grid. Keys: `1..3` views, `Enter` → DES of ETF/holding. CSV: per view columns above.

#### MEMB — Index Members

| | |
| --- | --- |
| code / aliases | `MEMB` / `MEMBERS` · tier 2 · reference · assetClasses index (or none with arg) · pageable |
| params | `z.object({ index: z.string().optional(), asOf: z.iso.date().optional(), compareTo: z.iso.date().optional(), groupBy: z.enum(['none','GICS_SECTOR']).default('GICS_SECTOR'), sort: z.object({ col: z.string(), dir: z.enum(['asc','desc']) }).default({ col: 'weight', dir: 'desc' }), pageSize: z.number().int().default(600) })` · grammar positional `[index?]` |
| fieldClasses | holdings, quote, reference |
| live | `{subjects: rows 'q:', fields:['PX_LAST','CHG_PCT_1D']}` |

Payload: `{ index: { code: string; name: string; asOf: string; source: string; memberCount: number }; rows: Array<{ iid: string; key: string; name: string; weight: number | null; shares: number | null; value: number | null; gicsSector: string | null; px: FieldValue; chgPct: FieldValue; contribution: number | null; dateAdded: string | null }>; changes: { since: string; added: Array<{ key: string; name: string }>; dropped: Array<{ key: string; name: string }> } | null; sectorWeights: Array<{ sector: string; weight: number; count: number }> }`.
Deps: `index_memberships` (N-PORT 2026-06-30 and SSGA 2026-09-14 vintages), `instrument_classifications`, plant. Screen: sector-grouped grid with subtotal rows, changes strip. Keys: `G` group toggle, `D` compare-date prompt, `Enter` → DES, `W` add focused to watchlist, `Ctrl+A` create watchlist from members. CSV: `key,name,sector,weight,shares,value,px,chgPct,contribution,dateAdded`.

#### BTMM — Treasury & Money Markets Monitor

| | |
| --- | --- |
| code / aliases | `BTMM` / `MMKT` · tier 2 · monitor · assetClasses none |
| params | `z.object({ country: z.literal('US').default('US') })` |
| fieldClasses | rates, curve, quote, fx |
| live | `{subjects:['q:<SPX>','q:<VIX>','q:<EURUSD>','q:<USDJPY>','q:<GBPUSD>','rate:SOFR','rate:EFFR'], fields:'*'}` |

Payload: `{ policy: { targetFrom: number; targetTo: number; asOf: string; nextFomc: string | null; iorb: number | null }; overnight: Array<{ code: 'SOFR' | 'EFFR' | 'OBFR' | 'TGCR' | 'BGCR'; value: number; chg1d: number | null; pct1: number | null; pct99: number | null; volumeBn: number | null; date: string }>; sofrAverages: { d30: number; d90: number; d180: number; index: number; date: string } | null; bills: Array<{ tenor: '4WK' | '6WK' | '8WK' | '13WK' | '17WK' | '26WK' | '52WK'; discount: number | null; yield: number | null; cusip: string | null; maturity: string | null; date: string }>; cmt: Array<{ tenor: string; yield: number; chg1d: number | null; date: string }>; spreads: { t2s10s: number | null; t3m10y: number | null; sofrEffr: number | null }; fx: Array<{ pair: string; px: FieldValue; chgPct: FieldValue }>; indices: Array<{ key: string; px: FieldValue; chgPct: FieldValue }>; asOf: string }`.
Deps: `rates_observations` (NY Fed all, H.15), `curve_points` (`UST_BILL`, `UST_PAR`), `fomc_meetings`,
`econ_observations` (`FRED:IORB`), plant. Screen: dense 3×2 kv/grid blocks (policy, overnight,
bills, CMT, spreads, FX/indices). Keys: `Enter` on a rate → DES (rate variant), `C` → CRVF, `W` → WIRP,
`F` → FED. CSV: `block,label,value,chg,date,source`.

#### FXC — FX Cross Matrix

| | |
| --- | --- |
| code / aliases | `FXC` / `FX`, `CROSS` · tier 2 · monitor · assetClasses none (or fx) |
| params | `z.object({ currencies: z.array(z.string().length(3)).min(2).max(12).default(['USD','EUR','JPY','GBP','CHF','CAD','AUD','NZD','SEK','NOK']), mode: z.enum(['spot','chg_pct','inverse']).default('spot'), source: z.enum(['intraday','ecb']).default('intraday') })` |
| fieldClasses | fx, quote |
| live | `{subjects: pairs with Yahoo lines ('q:<EURUSD>'…), fields:['PX_LAST','CHG_PCT_1D','STALE_TIER']}` |

Payload: `{ currencies: string[]; matrix: Array<Array<{ rate: number | null; chgPct: number | null; iid: string | null; derived: boolean; stale: StalenessTier }>>; ecbDate: string | null; asOf: string }` — direct pairs from Yahoo `XXXYYY=X` instruments; crosses without a line are derived via USD (`derived:true`, italic). Deps: `fx_rates` (frankfurter EOD), plant. Screen: matrix grid (row ccy → col ccy), mode badge. Keys: `M` mode cycle, `Enter` → DES of pair, `G` → GP, `E` ECB reference toggle. CSV: `base,quote,rate,chgPct,derived,source,asOf`.

#### WB — World Bond Markets

| | |
| --- | --- |
| code / aliases | `WB` / `BONDS` · tier 2 · monitor · assetClasses none |
| params | `z.object({ tenor: z.enum(['2Y','5Y','10Y','30Y']).default('10Y'), countries: z.array(z.string()).default(['US','DE','GB','JP','FR','IT','CA','AU']) })` |
| fieldClasses | rates, curve |
| live | `{subjects:['q:<TNX>'], fields:['PX_LAST','CHG_NET_1D']}` (Cboe/Yahoo `^TNX` 10Y yield index, intraday) |

Payload: `{ rows: Array<{ country: string; tenor: string; yield: number | null; chg1d: number | null; chg1w: number | null; chg1m: number | null; spreadToUst: number | null; asOf: string; frequency: 'D' | 'M'; source: string; seriesId: string }>; usCurve: Array<{ tenor: string; yield: number }>; intraday10y: FieldValue | null }` — US from `UST_PAR`; others from FRED OECD long-term rates (`IRLTLT01DEM156N`, `IRLTLT01GBM156N`, `IRLTLT01JPM156N`, `IRLTLT01FRM156N`, `IRLTLT01ITM156N`, `IRLTLT01CAM156N`, `IRLTLT01AUM156N`) monthly, marked `frequency:'M'` with a `MONTHLY` staleness badge; 2Y/5Y/30Y only for US (others `null`, reason `TENOR_UNAVAILABLE_SOURCE`). Screen: grid + US curve sparkline. Keys: `T` tenor cycle, `Enter` → DES of series, `G` → GP. CSV: `country,tenor,yield,chg1d,chg1w,chg1m,spreadToUst,asOf,frequency,source`.

### 4.3 Tier 3

#### YAS — Yield and Spread Analysis (Treasuries)

| | |
| --- | --- |
| code / aliases | `YAS` / `YA` · tier 3 · rates · assetClasses govt |
| params | `z.object({ input: z.enum(['price','yield']).default('yield'), price: z.number().optional(), yield: z.number().optional(), settlement: z.iso.date().optional(), curveId: z.enum(['UST_PAR','UST_ZERO','SOFR_OIS']).default('UST_PAR'), face: z.number().default(1_000_000) })` · grammar positional `[price|yield?]` (a number < 30 is a yield, else a price), keyed `S=` settlement |
| fieldClasses | rates, curve, reference |

Payload: `{ terms: DesPayload_govt['terms']; settlement: string; inputs: { price: number; yield: number; source: 'user' | 'curve' }; results: { price: number; yield: number; accrued: number; dirtyPrice: number; macDuration: number; modDuration: number; convexity: number; dv01: number; dv01Face: number; yieldValueOf32nd: number; bpvOfFace: number; keyRateDurations: Array<{ tenor: string; krd: number }>; spreads: { toCurveBp: number | null; toBenchmarkBp: number | null; benchmarkKey: string | null; zSpreadBp: number | null }; discountMargin: null }; cashflows: Array<{ date: string; coupon: number; principal: number; total: number; df: number | null; pv: number | null }>; engine: { name: 'core/analytics/bond'; version: string; conventions: { dayCount: string; freq: number; bdc: string; calendar: string; compounding: 'street' } }; curve: { id: string; date: string; provIdx: number } }`.
Deps: `govt_terms`, `curve_points`, `calendar_holidays`; engine `core/analytics/bond/*` (ANAL-01/08).
Screen: left `form` (input mode, price/yield, settlement) | right kv results + KRD mini-bars | cashflow
grid. Keys: `Tab` toggle price/yield input, `↑/↓` bump 1 bp (yield) or 1/32 (price), `Shift+↑/↓` 10×,
`S` settlement prompt, `C` curve cycle, `Enter` recompute. CSV: `field,value,unit` for results + `date,coupon,principal,total,df,pv` cashflow section.

#### CRVF / ICVS — Curve Construction

| | |
| --- | --- |
| code / aliases | `CRVF` / `CURVE`; `ICVS` / `OIS` is the same manifest with defaults `{curveId:'SOFR_OIS'}` · tier 3 · rates · assetClasses none · screenKind custom (`CurveChart`) |
| params | `z.object({ curveId: z.enum(['UST_PAR','UST_BILL','UST_ZERO','SOFR_OIS','FED_H15_CMT']).default('UST_PAR'), date: z.iso.date().optional(), compare: z.array(z.iso.date()).max(3).default([]), view: z.enum(['table','chart','both']).default('both'), interpolation: z.enum(['linear_zero','loglinear_df','monotone_convex']).default('monotone_convex'), outputs: z.array(z.enum(['par','zero','df','fwd3m','fwd1y'])).default(['par','zero','df','fwd3m']) })` · grammar positional `[curveId?, date?]` |
| fieldClasses | curve, rates |

Payload: `{ curve: { id: string; name: string; date: string; kind: string; dayCount: string; compounding: string; buildMethod: string; caveats: string[] }; tenors: Array<{ tenor: string; days: number; par: number | null; zero: number | null; df: number | null; fwd3m: number | null; fwd1y: number | null; input: { value: number; instrument: string; provIdx: number } | null }>; compare: Array<{ date: string; tenors: Array<{ tenor: string; par: number | null; zero: number | null }> }>; engine: { name: 'core/analytics/curve'; version: string; interpolation: string } }`.
`SOFR_OIS` build (ICVS): inputs = SOFR overnight (NY Fed), SOFR 30/90/180-day averages (realised,
used as front-end proxies), bills 4WK–52WK (Treasury), CMT 2Y–30Y as term proxies; `buildMethod:
'proxy:v1'`, `caveats: ['NO_OIS_SWAP_QUOTES_SOURCE: term points proxied by bills/CMT']` rendered as a
persistent amber badge. Deps: `curve_points`, `rates_observations`; engine `core/analytics/curve/*`
(ANAL-02). Screen: chart (par/zero/fwd lines, compare dates dashed) | tenor grid. Keys: `D` date prompt,
`C` add compare date, `I` interpolation cycle, `O` outputs picker, `Enter` on tenor → input provenance.
CSV: `tenor,days,par,zero,df,fwd3m,fwd1y,inputValue,inputInstrument` (+ one section per compare date).

#### WIRP — Implied Policy Path

| | |
| --- | --- |
| code / aliases | `WIRP` / `FFIP`, `PATH` · tier 3 · rates · assetClasses none |
| params | `z.object({ curveId: z.enum(['SOFR_OIS','UST_BILL']).default('SOFR_OIS'), date: z.iso.date().optional(), stepBp: z.number().default(25), meetings: z.number().int().min(1).max(10).default(8) })` |
| fieldClasses | curve, rates |

Payload: `{ current: { targetFrom: number; targetTo: number; mid: number; effr: number; sofr: number; asOf: string }; meetings: Array<{ date: string; daysAhead: number; impliedRate: number; impliedChangeBp: number; cumulativeBp: number; probHike: number; probCut: number; probHold: number; expectedMoves: number }>; method: { name: 'forward-overnight-stepping'; description: string; curveId: string; caveats: string[] }; provIdx: number[] }` — forward overnight rate between consecutive FOMC dates from the curve's discount factors; implied change = fwd − current mid; probability of a ±25 bp move = clamp(|implied change| / 25, 0, 1) attributed to hike/cut by sign (documented simplification, no futures source). Deps: `curve_points`, `fomc_meetings`, `rates_observations`; engine `core/analytics/curve/policyPath.ts`. Screen: meetings grid + implied path chart (`custom: 'CurveChart'` step). Keys: `C` curve cycle, `D` date, `Enter` → FED. CSV: `meeting,daysAhead,impliedRate,impliedChangeBp,cumulativeBp,probHike,probCut,probHold`.

#### OVML — Option Valuation

| | |
| --- | --- |
| code / aliases | `OVML` / `OV`, `OPTVAL` · tier 3 · derivatives · assetClasses option, equity, etf, index (underlying → picks ATM contract) |
| params | `z.object({ putCall: z.enum(['C','P']).optional(), strike: z.number().optional(), expiry: z.iso.date().optional(), style: z.enum(['european','american']).optional(), model: z.enum(['bsm','black76','crr','trinomial','mc']).default('bsm'), spot: z.number().optional(), vol: z.union([z.number(), z.literal('implied')]).default('implied'), rate: z.union([z.number(), z.literal('sofr')]).default('sofr'), divYield: z.number().optional(), steps: z.number().int().min(10).max(5000).default(500), paths: z.number().int().min(1000).max(2_000_000).default(200_000), seed: z.number().int().default(42), valuationTs: z.iso.datetime().optional(), scenario: z.object({ spotPct: z.array(z.number()).default([-10,-5,0,5,10]), volPts: z.array(z.number()).default([-5,0,5]) }).default({}) })` · grammar positional `[putCall?, strike?, expiry?]`, keyed `VOL=`, `MODEL=` |
| fieldClasses | options, quote, rates, derived |
| live | `{subjects:['q:<underlying>','chain:<underlying>'], fields:['PX_LAST','OPT_IV','OPT_DELTA']}` |

Payload: `{ contract: { occ: string | null; underlyingKey: string; putCall: 'C' | 'P'; strike: number; expiry: string; style: string; multiplier: number; daysToExpiry: number; yearFrac: number }; inputs: { spot: number; vol: number; volSource: 'implied_mid' | 'user' | 'iv30'; rate: number; rateSource: string; divYield: number; valuationTs: string; model: string; steps?: number; paths?: number; seed?: number }; results: { price: number; delta: number; gamma: number; vega: number; theta: number; rho: number; impliedVol: number | null; intrinsic: number; timeValue: number; stdError?: number; d1?: number; d2?: number }; market: { bid: number | null; ask: number | null; mid: number | null; last: number | null; iv: number | null; cboeGreeks: { delta: number | null; gamma: number | null; vega: number | null; theta: number | null; rho: number | null; theo: number | null } | null; asOf: string | null }; scenario: { spotPct: number[]; volPts: number[]; prices: number[][]; deltas: number[][] }; engine: { name: string; version: string } }`.
Deps: `option_terms`, `option_chain_snapshots`, plant, `rates_observations` (SOFR), `corporate_actions`
(trailing 12-m dividends → yield); engines `core/analytics/options/*` (ANAL-03/08). Screen: contract
+ inputs `form` (left) | results kv + market comparison (right) | scenario grid (bottom). Keys: `Tab`
fields, `M` model cycle, `V` vol source toggle, `Enter` recompute, `S` scenario axis prompt, `O` → OMON.
CSV: `field,value` sections `contract,inputs,results,market` + scenario matrix `spotPct,volPts,price,delta`.

#### OMON — Option Monitor

| | |
| --- | --- |
| code / aliases | `OMON` / `CHAIN` · tier 3 · derivatives · assetClasses equity, etf, index · pageable (expiries) |
| params | `z.object({ expiry: z.iso.date().optional(), strikesAround: z.number().int().min(5).max(50).default(12), view: z.enum(['straddle','calls','puts']).default('straddle'), columns: z.array(z.string()).default(['OPT_BID','OPT_ASK','OPT_LAST','OPT_IV','OPT_DELTA','OPT_GAMMA','OPT_THETA','OPT_VEGA','OPT_VOLUME','OPT_OI']), moneyness: z.enum(['all','otm','itm']).default('all') })` · grammar positional `[expiry?]` |
| fieldClasses | options, quote |
| live | `{subjects:['chain:<iid>','q:<iid>'], fields: columns, conflateMs: 500}` |

Payload: `{ underlying: { key: string; px: FieldValue; chgPct: FieldValue; iv30: number | null }; expiries: Array<{ date: string; dte: number; count: number }>; expiry: string; rows: Array<{ strike: number; call: ChainLeg | null; put: ChainLeg | null }>; asOf: string; source: 'cboe' }` with `ChainLeg = { iid: string; occ: string; bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null; last: number | null; lastTs: string | null; iv: number | null; delta: number | null; gamma: number | null; vega: number | null; theta: number | null; rho: number | null; theo: number | null; volume: number | null; oi: number | null; chg: number | null; chgPct: number | null; tick: string | null }`.
Deps: `option_terms`, `option_chain_snapshots`; provider Cboe options chain (5-min TTL, 60 s while
subscribed). Screen: straddle grid (calls | strike | puts), ATM row highlighted, expiry tabs. Keys:
`←/→` or `PageUp/PageDown` expiry, `V` view cycle, `+/-` strikes around, `G` greeks columns toggle,
`Enter` → OVML on focused leg, `D` → DES of contract, `S` → vol smile chart (custom `OptionSurface`,
SVI fit from `core/analytics/options/surface.ts`, ANAL-04). CSV: `expiry,strike,side,occ,bid,ask,last,iv,delta,gamma,vega,theta,rho,theo,volume,oi`.

#### SWPM — Swap Manager (SOFR OIS)

| | |
| --- | --- |
| code / aliases | `SWPM` / `SWAP` · tier 3 · rates · assetClasses none |
| params | `z.object({ notional: z.number().default(10_000_000), effective: z.iso.date().optional(), tenor: z.string().default('5Y'), maturity: z.iso.date().optional(), payReceive: z.enum(['pay','receive']).default('pay'), fixedRate: z.number().optional() /* undefined = par */, fixedFreq: z.enum(['A','S','Q']).default('A'), floatIndex: z.literal('SOFR').default('SOFR'), floatFreq: z.enum(['A','S','Q']).default('A'), dayCount: z.enum(['ACT/360','ACT/365F','30/360']).default('ACT/360'), paymentLagDays: z.number().int().default(2), curveId: z.literal('SOFR_OIS').default('SOFR_OIS'), valuationDate: z.iso.date().optional() })` · grammar positional `[tenor?, fixedRate?]` |
| fieldClasses | curve, rates |

Payload: `{ trade: { effective: string; maturity: string; notional: number; payReceive: string; fixedRate: number; parRate: number; conventions: Record<string, string> }; valuation: { npv: number; npvFixed: number; npvFloat: number; dv01: number; parRate: number; accrued: number; valuationDate: string; curveDate: string }; fixedLeg: Array<{ start: string; end: string; pay: string; days: number; yearFrac: number; rate: number; cashflow: number; df: number; pv: number }>; floatLeg: Array<{ start: string; end: string; pay: string; days: number; yearFrac: number; fwdRate: number; cashflow: number; df: number; pv: number; realised: boolean }>; risk: { keyRate: Array<{ tenor: string; dv01: number }> }; engine: { name: 'core/analytics/curve/ois'; version: string; curveBuild: string; caveats: string[] } }`.
Deps: `curve_points` (`SOFR_OIS`), `rates_observations` (realised SOFR for stub), `calendar_holidays` (SIFMA). Screen: trade `form` | valuation kv | legs grids (tabs). Keys: `Tab` fields, `P` pay/receive, `Enter` price, `R` solve par, `1/2` leg tabs. CSV: `leg,start,end,pay,days,yearFrac,rate,cashflow,df,pv` + `field,value` valuation section.

#### SRCH — Treasury Search

| | |
| --- | --- |
| code / aliases | `SRCH` / `BSRCH` · tier 3 · screening · assetClasses none · pageable |
| params | `z.object({ secType: z.array(z.enum(['bill','note','bond','tips','frn'])).default(['bill','note','bond']), maturityFrom: z.iso.date().optional(), maturityTo: z.iso.date().optional(), couponMin: z.number().optional(), couponMax: z.number().optional(), benchmarkOnly: z.boolean().default(false), sort: z.object({ col: z.string(), dir: z.enum(['asc','desc']) }).default({ col: 'maturity', dir: 'asc' }), pageSize: z.number().int().default(100) })` |
| fieldClasses | reference, rates, curve |

Payload: `{ rows: Array<{ iid: string; key: string; cusip: string; secType: string; coupon: number | null; maturity: string; issueDate: string; benchmarkTenor: string | null; yield: number | null; price: number | null; modDuration: number | null; yieldSource: 'curve_interp' }>; total: number; curveDate: string }`.
Deps: `govt_terms`, `curve_points`, engine bond. Screen: criteria form | grid. Keys: `Ctrl+Enter` run, `Enter` → YAS, `D` → DES, `Ctrl+S` save. CSV: `key,cusip,secType,coupon,maturity,issueDate,benchmarkTenor,yield,price,modDuration`.

#### GC — Treasury Benchmark Curve Chart

| | |
| --- | --- |
| code / aliases | `GC` / `GCRV` · tier 3 · charting · assetClasses none · custom (`CurveChart`) |
| params | `z.object({ curveId: z.enum(['UST_PAR','FED_H15_CMT','SOFR_OIS']).default('UST_PAR'), dates: z.array(z.iso.date()).max(6).optional() /* default: today, -1W, -1M, -3M, -1Y */, tenors: z.array(z.string()).optional(), showChange: z.boolean().default(true) })` |
| fieldClasses | curve |

Payload: `{ curves: Array<{ date: string; label: string; points: Array<{ tenor: string; days: number; value: number }>; provIdx: number }>; changesBp: Array<{ tenor: string; vsPrev: number | null; vs1w: number | null; vs1m: number | null; vs1y: number | null }>; curveId: string }`.
Deps: `curve_points`. Screen: chart (tenor x-axis, one line per date) + change table. Keys: `1..6`
toggle dates, `D` add date, `T` tenor set, `Enter` on tenor → CRVF. CSV: `date,tenor,days,value` + change table.

#### FED — Fed Monitor

| | |
| --- | --- |
| code / aliases | `FED` / `FOMC` · tier 3 · monitor · assetClasses none |
| params | `z.object({})` |
| fieldClasses | rates, econ, news, curve |
| live | `{subjects:['news:FED','rate:EFFR','rate:SOFR'], fields:'*'}` |

Payload: `{ policy: { targetFrom: number; targetTo: number; effr: number; iorb: number | null; sofr: number; asOf: string }; calendar: Array<{ date: string; daysAhead: number; hasSep: boolean; impliedChangeBp: number | null }>; balanceSheet: { total: number | null; date: string | null; chg4w: number | null; seriesId: 'FRED:WALCL' } ; history: { effr: Array<[string, number]>; sofr: Array<[string, number]>; target: Array<[string, number, number]> }; press: Array<{ newsId: string; headline: string; publishedAt: string; category: string | null; url: string }>; nextMeeting: { date: string; daysAhead: number; impliedChangeBp: number | null; probHike: number | null; probCut: number | null } | null }`.
Deps: `rates_observations`, `fomc_meetings`, `econ_observations` (`FRED:WALCL`, `FRED:IORB`), `news_items` (fedrss), WIRP engine. Screen: policy kv | calendar grid | press list | history chart. Keys: `W` → WIRP, `Enter` on press → open URL, `C` → CRVF SOFR_OIS. CSV: `section,label,value,date`.

#### CRYP — Crypto Monitor (context only)

| | |
| --- | --- |
| code / aliases | `CRYP` / `CRYPTO` · tier 3 · monitor · assetClasses none |
| params | `z.object({ ids: z.array(z.string()).default(['bitcoin','ethereum','solana','ripple']) })` |
| fieldClasses | crypto |
| live | `{subjects:['q:<BTC>','q:<ETH>',...], fields:['PX_LAST','CHG_PCT_24H','STALE_TIER']}` |

Payload: `{ rows: Array<{ iid: string; key: string; name: string; px: FieldValue; chg24hPct: FieldValue; asOf: string }>; source: 'coingecko'; caveat: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA' }`. Deps: plant (CoinGecko 60 s poll). Screen: grid. Keys: `Enter` → DES (crypto). CSV: `key,name,px,chg24hPct,asOf`.

---

## 5. Usage instrumentation (FUNC-04)

| Event | Emitted by | Fields |
| --- | --- | --- |
| `function.launch` | client `dispatch()` and server `runner.ts` (server row is authoritative; client row carries `duration_ms` to first paint) | code, securityKey, params, panel, traceId |
| `function.param` | client `ctx.setParams` → re-run with header `x-usage-kind: param` | code, params diff |
| `function.export` | server export route | code, resultId, rows |
| `function.page` | server page route | code, direction |
| `function.help` / `help.ticket` | client HELP handling / server ticket route | code |
| `cmd.parse` | client, sampled 1/20, only `shape` and `problems[].code` (never raw text of unresolved input beyond 32 chars) | shape, problem codes, candidates count, latency |
| `panel.switch`, `ws.slow`, `ws.resync` | client | panel, level |

Client events are batched (`POST /usage/events`, ≤ 50 per 5 s); server events are written by
`usage/events.ts` (batched insert). `GET /usage/functions?days=30` produces the roadmap table.

---

## 6. Registry generation and file ownership

- `packages/core/src/functions/manifests/<CODE>.ts` — one file per function, default export
  `defineFunction(...)`. `manifests/index.ts` is generated by `scripts/gen-function-index.ts`
  (`npm run gen:functions`) which globs the directory — never hand-edited (WORKPLAN ownership).
- `packages/server/src/functions/<CODE>/resolve.ts` exports `FunctionServerModule`; `functions/index.ts` generated the same way.
- `packages/web/src/functions/<CODE>/Screen.tsx` exports `Screen: FunctionScreen`; `functions/index.ts` generated.
- `fixtures/golden/functions/<CODE>.<variant>.json` — payload snapshot produced in replay mode; the
  test `functions.golden.test.ts` asserts resolver output equals the snapshot and `toCsv` output equals
  `fixtures/golden/functions/<CODE>.<variant>.csv` (API-05 numeric identity).
- Adding function 41 costs: one manifest, one resolver, one screen, one golden pair. Nothing else changes.
