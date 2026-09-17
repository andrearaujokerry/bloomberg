### ECO — Economic Calendar

| Attribute | Value |
| --- | --- |
| Code / aliases | `ECO` / `CAL`, `CALENDAR` (no `aliasParams`) |
| Tier / category | 2 / monitor |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `true` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/ECO.ts` · `packages/server/src/functions/ECO/resolve.ts` · `packages/web/src/screens/ECO/Screen.tsx` · `fixtures/golden/functions/ECO.default.{json,csv}` (calendar mode), `fixtures/golden/functions/ECO.default-release.{json,csv}` (release mode) |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (DATA-07) (DATA-08) (DATA-10) (STOR-06) (TERM-08) (TERM-12) (ENTL-05) (API-05) (NEWS-08) |

#### Params
```ts
export const EcoParams = z.object({
  range: z.enum(['D', 'W', 'M']).default('W'),          // day / week (Mon–Sun) / calendar month, anchored on `date`
  date: z.iso.date().optional(),                        // anchor day; undefined = ctx.asOf.validAt in America/New_York
  country: z.enum(['US', 'ALL']).default('US'),
  importance: z.number().int().min(1).max(3).default(1),// minimum econ_releases.importance shown (1 = show everything)
  releaseId: z.number().int().positive().optional(),    // set → release-detail mode (econ_releases.release_id)
  fomc: z.boolean().default(true),                      // include the FOMC block
});
```
#### Argument grammar
`positional [{ name:'range', type:'enum', values:['D','W','M'], optional:true }, { name:'date', type:'date', optional:true }]`, `keyed { CTY: { name:'country', type:'enum', values:['US','ALL'] }, IMP: { name:'importance', type:'int' }, REL: { name:'releaseId', type:'int' }, FOMC: { name:'fomc', type:'boolean' } }`, no `rest`.
Examples: `ECO` → `{ range:'W', country:'US', importance:1, fomc:true }` · `ECO M 2026-10-05 CTY=ALL IMP=2` → `{ range:'M', date:'2026-10-05', country:'ALL', importance:2 }` · `ECO REL=10` → `{ releaseId:10 }` (release-detail mode for FRED release 10, Consumer Price Index).

#### Payload
```ts
export type EcoImportance = 1 | 2 | 3;
export type EcoSourceId = 'fred.calendar' | 'bls.schedule' | 'fed.fomc';

/** One scheduled or released macro print. `consensus` is structurally null: the wedge has no estimates provider (BRIEF §2). */
export interface EcoEventRow {
  eventId: number; releaseId: number; releaseName: string; sourceId: EcoSourceId;
  country: string; url: string | null; importance: EcoImportance;
  scheduledAt: string; timeKnown: boolean;                       // timeKnown=false → FRED date at 08:30 ET, screen shows 'ET —'
  periodLabel: string;                                            // 'August 2026'
  seriesCode: string | null; seriesName: string | null; units: string | null; decimals: number | null;
  actual: ValueCell; prior: ValueCell; revisedPrior: ValueCell;   // ECO_VALUE / ECO_PRIOR / ECO_PRIOR (revised vintage)
  consensus: { v: null; r: 'NO_CONSENSUS_SOURCE' }; surprisePct: null;
  status: 'scheduled' | 'released' | 'revised' | 'delayed' | 'cancelled';
  subject: string | null;                                         // 'e:CUUR0000SA0' when seriesCode is known
  provIdx: number;
}
export type EcoPayload = {
  variant: 'default';
  mode: 'calendar' | 'release';
  window: { from: string; to: string; tz: 'America/New_York'; label: string };   // label 'Week of 2026-09-14'
  country: 'US' | 'ALL'; importance: EcoImportance;
  days: Array<{ date: string; isBusinessDay: boolean; events: EcoEventRow[] }>;  // every day of the window, empty days kept
  fomc: Array<{ meetingDate: string; statementAt: string | null; hasSep: boolean; decisionBp: number | null;
                isNext: boolean; inWindow: boolean; provIdx: number }>;
  release: {
    releaseId: number; name: string; sourceId: EcoSourceId; country: string; url: string | null; importance: EcoImportance;
    events: EcoEventRow[];                                                        // last 12 events of this release, newest first
    series: Array<{ seriesCode: string; name: string; units: string; frequency: 'D'|'W'|'M'|'Q'|'A'; seasonalAdj: string | null;
                    decimals: number | null; lastObsDate: string | null; lastUpdatedAt: string | null;
                    observations: Array<{ obsDate: string; value: number | null; status: 'final'|'preliminary'|'revised'|'missing';
                                          vintageAt: string; isLatest: boolean; footnote: string | null; provIdx: number }>;
                    revisions: Array<{ obsDate: string; vintages: Array<{ vintageAt: string; value: number | null; status: string }> }>;
                    chart: Array<{ t: number; v: number | null }> }>;             // oldest → newest, for the custom Sparkline node
    nextEvent: EcoEventRow | null;
  } | null;                                                                        // null in calendar mode
  consensus: { value: null; reason: 'NO_CONSENSUS_SOURCE' };
  knownAt: string;
  cursor: { prev: string; next: string };                                          // base64url(JSON) — see Resolver step 7
};
```

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `econ_release_events`, `econ_releases`, `econ_series`, `econ_observations` (vintages; read with `vintage_at ≤ knownAt`, STOR-06), `fomc_meetings`, `calendars` / `calendar_holidays` (`USGOVT` for business days), `instruments` (asset_class `econ`, for the `e:` subject and GP hand-off), `provenance` |
| Data services (§1.4.2) | `data.econ.calendar`, `data.econ.fomc`, `data.econ.series`, `data.econ.observations`, `data.reference.calendar`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | Calendar mode: **None** — `ReadThroughKind` (§1.4.2) has no `fred.calendar`/`bls.schedule`/`fed.fomc` member, so the calendar is only as fresh as the `econCalendar.ts` job (daily 05:00 ET, ARCHITECTURE §7.1); when `max(econ_release_events.provenance.captured_at) < ctx.clock.now() − 36 h` the resolver adds the footer note `CALENDAR_STALE` and `ctx.prov.add({ …, st:'stale' })` (TERM-12). Release mode: `('fred.series', seriesCode, { maxAgeMs: 3_600_000 })` for each series of the release whose `last_updated_at` is older than one hour |
| Engines (`core/analytics`) | None. (`revisedPrior` and the vintage diff are resolver arithmetic; `meta.engines` empty) |
| Subjects (live) | `e:<seriesCode>` for every event whose `scheduledAt` falls inside `[now − 2 h, now + 12 h]` and whose `seriesCode` is not null (calendar mode); `e:<seriesCode>` for every series of the release (release mode) |
| Field ids (`fieldIds(assetClass)`) | `default: [ECO_VALUE, ECO_PRIOR, ECO_RELEASE_DT, ECO_PERIOD, ECO_VINTAGE]` |

#### Resolver
Single `resolve` (`assetClasses: 'none'`, no variants):
1. `anchor = params.date ?? formatDate(ctx.asOf.validAt, 'America/New_York')`. `window` from `params.range`: `D` → `[anchor, anchor]`; `W` → Monday..Sunday of `anchor`'s ISO week; `M` → first..last day of `anchor`'s month. `knownAt = ctx.asOf.knownAt` (STOR-06 — an export re-supplies it, so a re-run reproduces the same vintages). When `ctx.page` is present, `anchor` comes from the decoded cursor instead (step 7).
2. Calendar mode (`params.releaseId === undefined`): `events = await ctx.data.econ.calendar({ from: window.from, to: window.to, country: params.country })`, filtered to `importance ≥ params.importance`. One `ctx.prov.add({ sourceId: e.sourceId, provenanceId: e.provenanceId, capturedAt, sourceTs: null, st: calendarStale ? 'stale' : 'closed', tier:'eod' })` per distinct `provenance_id`, cached in a Map so each event's `provIdx` reuses it.
3. Per event build `EcoEventRow`: `actual = { v: e.actual, st: e.status === 'scheduled' ? 'blank' : 'closed', ts: e.scheduledAt, provIdx }`; `prior = { v: e.prior, st:'closed', … }`; `revisedPrior = { v: e.revisedPrior, st: e.revisedPrior === null ? 'na' : 'closed', … }` (`'na'` because a print that was never revised has no revised prior — not a denial, so no `r`). `consensus = { v: null, r: 'NO_CONSENSUS_SOURCE' }` and `surprisePct: null` on **every** row; `econ_release_events.consensus` is `NULL` by schema and `consensus_unavailable_reason` carries the same code. `ctx.unavailable.add({ field:'consensus', reason:'NO_SOURCE', detail:'NO_CONSENSUS_SOURCE: no consensus-estimates provider is reachable in the wedge (BRIEF §2); the column is never populated' })` exactly once per run — never a fabricated or back-filled number (NEWS-08).
4. `subject = e.seriesCode ? 'e:' + e.seriesCode : null`; collect the subjects of events inside `[now − 2 h, now + 12 h]`, `plant.ensureHot(subjects)`, then `plant.snapshotMany(subjects)`; when a state exists, `actual` is rebuilt with `cellFromState(ctx, state, 'ECO_VALUE', subject)` (Tier 1 §0.4 rule 1) so a print that lands while the screen is open flashes in place. Monitor rule §0.4 rule 2 applies: the resolver never calls `providers.ensure` for these subjects.
5. `days` = every date in the window (inclusive), `isBusinessDay` from `data.reference.calendar('USGOVT')`, `events` sorted by `scheduledAt` then `releaseName`; empty days are kept so the screen renders the week grid.
6. FOMC block when `params.fomc`: `meetings = await ctx.data.econ.fomc()`; keep meetings in the window plus the next two after `ctx.asOf.validAt`; `isNext` on the first meeting with `meetingDate ≥ validAt`; `decisionBp` is `null` before the decision and is never estimated. One `prov.add` for the `fed.fomc` capture.
7. `ctx.page.set({ index: 0, count: 1, cursor: next })` with `next = base64url(JSON.stringify({ anchor: shift(anchor, params.range, +1), range: params.range }))` and `prev` the `−1` shift; PAGE FWD means the **later** window (next day/week/month), PAGE BACK the earlier one. Both are also returned in `payload.cursor` so the screen can label the arrows.
8. Release mode (`params.releaseId` set): `rel = econ_releases` row (404-equivalent → `ctx.unavailable.add({ field:'release', reason:'NO_SOURCE', detail:'unknown release id' })` and `release: null`). `events` = last 12 `econ_release_events` of the release ordered `scheduled_at DESC`, built as in step 3. For each `econ_series` with that `release_id`: `ensure('fred.series', seriesCode, 1 h)` when stale, then `data.econ.observations(seriesCode, { from: window.from − 5 y, to: window.to, knownAt })` → `observations` (latest vintage per `obs_date`) and `revisions` (every vintage of the last 8 `obs_date`s, so a revision is visible as data, not as prose). `chart` = `observations` oldest → newest as `{ t: Date.parse(obsDate), v }`. `days` is still populated for the window so `PAGE`/`Esc`-free navigation back to the calendar keeps context.
9. Return `{ variant:'default', mode, window, country, importance, days, fomc, release, consensus: { value:null, reason:'NO_CONSENSUS_SOURCE' }, knownAt: ISO(knownAt), cursor }`.
Budget: calendar mode 2 DB round-trips (events+releases join, fomc) + 1 plant snapshot, zero provider calls; < 120 ms p95. Release mode 4 DB round-trips; < 250 ms p95 warm, < 3 s cold (one FRED CSV per series).

#### Live
Calendar mode: `{ subjects: rows.filter(r => r.subject && withinWindow(r.scheduledAt)).map(r => r.subject!), fields: '*', conflationMs: 1000 }` — `e:` subjects are subscribed with `f: []` (API.md §6.1, Tier 1 §0.4 rule 5). Release mode: `{ subjects: release.series.map(s => 'e:' + s.seriesCode), fields: '*', conflationMs: 1000 }`. The events grid sets `live.subjectOf = row => row.subject`; the `actual` cell carries `Cell.live = { subject, field:'ECO_VALUE' }` so a release delta flashes the cell and flips `status` to `released` through the `status` frame.

#### Screen
```
calendar (mode = 'calendar')
┌ ECO · Economic Calendar · Week of 2026-09-14 (US) ───────────────────────────────┐
│ tabs#range   [1 Day] [2 Week] [3 Month]      badges#mode [US] [IMP ≥ 1] [FOMC ON] │
│ badges#reason [CONSENSUS UNAVAILABLE · NO_CONSENSUS_SOURCE] [CALENDAR_STALE?]     │
│ grid#events  groupBy 'date' — one group header per day (Mon 14 Sep · business)    │
│   time (ET, datetime; '—' when timeKnown=false) | release | period | series       │
│   | actual (live, fmt px, decimals from series) | prior (px) | revised (px)       │
│   | consensus (always '—', tooltip NO_CONSENSUS_SOURCE) | status badge            │
│ table#fomc   meeting date | statement (14:00 ET) | SEP | decision bp ('—' before) │
│ footer: sources ['FRED release calendar','BLS release schedule','FOMC calendar']  │
│         asOf=knownAt · notes ['PAGE FWD = next week']                            │
└──────────────────────────────────────────────────────────────────────────────────┘
release (mode = 'release')
┌ ECO · Consumer Price Index · release 10 (FRED) ──────────────────────────────────┐
│ kv#release   publisher · country · importance · next event (datetime + period)    │
│              last actual · prior · revised prior · consensus — NO_CONSENSUS_SOURCE │
│ custom#spark Sparkline { points: release.series[0].chart, fmt:'px' }              │
│ grid#events  scheduled | period | actual | prior | revised | status | url          │
│ grid#vintages obsDate | vintageAt | value | status   (the revision audit, STOR-06) │
│ footer: sources ['FRED (public domain)'] asOf=knownAt                             │
└──────────────────────────────────────────────────────────────────────────────────┘
```
Title `ECO · Economic Calendar · <window.label> (<country>)` / `ECO · <release.name> · release <id>`; subtitle `<range> · IMP ≥ <importance>`. `initialFocus:'events'`. Skeleton while `payload === undefined`: the tabs row plus `grid#events` with 12 muted rows and no group headers. `meta.unavailable` renders as the `badges#reason` row and as the `consensus` column tooltip; `meta.entitlement` denials on `ECO_VALUE` blank the `actual` column with `—` and the reason text (ENTL-05); `meta.staleness:'stale'` adds the stale glyph to `badges#mode` and the `CALENDAR_STALE` badge (TERM-12). `timeKnown === false` renders the time cell as `—` with the tooltip `FRED publishes the date only; 08:30 ET assumed for ordering`.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1` / `2` / `3` | always | `tab-range` | `ctx.setParams({ range: 'D' \| 'W' \| 'M' })` (usage `fn.param`) |
| `C` | always | `cycle-country` | `US → ALL → US` via `setParams({ country })` |
| `I` | always | `cycle-importance` | `1 → 2 → 3 → 1` via `setParams({ importance })` |
| `F` | always | `toggle-fomc` | `setParams({ fomc: !fomc })` |
| `T` | always | `today` | `setParams({ date: undefined })` — back to the window containing `ctx.asOf.validAt` |
| `+` / `-` | grid | `page-fwd` / `page-back` | `ctx.page('fwd')` / `ctx.page('back')` — later / earlier window |
| `Enter` | grid (`events`) | `open-release` | `ctx.navigate('ECO REL=' + row.releaseId)` (release-detail mode) |
| `Shift+Enter` | grid (`events`) | `open-release-next` | `ctx.navigateNext('ECO REL=' + row.releaseId)` |
| `G` | grid (`events`) | `open-gp` | `ctx.navigate(row.seriesCode + ' Index GP 5Y')` when `seriesCode` is set, else no-op |
| `N` | grid (`events`) | `open-news` | `ctx.navigate('NI ECO')` (economics topic feed) |
| `U` | grid (`events`) | `open-url` | `ctx.openUrl(row.url)` (FRED/BLS release page) |
| `Enter` | grid (`vintages`) | `open-hp` | `ctx.navigate(seriesCode + ' Index HP')` |

#### CSV
`filename = 'ECO_' + (params.releaseId ? 'REL' + params.releaseId : params.range + '_' + window.from.replace(/-/g,'')) + '_' + asOf.replace(/[-:]/g,'') + '.csv'`; `csvColumns` is `null` (payload-dependent).
`mode='calendar'` — one wide table, one row per event across all `days[]` in chronological order, columns `date,scheduledAt,timeKnown,country,releaseId,release,periodLabel,seriesCode,units,actual,prior,revisedPrior,consensus,consensusReason,status,importance,url` with `consensus` always empty and `consensusReason` always `NO_CONSENSUS_SOURCE`; FOMC meetings are appended as `section`-free rows whose `release` is `FOMC Meeting`, `seriesCode` empty and `actual` = `decisionBp` (unit bp) per §1.6 rule 3. Example: `2026-09-16,2026-09-16T12:30:00Z,true,US,10,Consumer Price Index,August 2026,CUUR0000SA0,Index 1982-1984=100,324.112,323.048,,,NO_CONSENSUS_SOURCE,released,2,https://fred.stlouisfed.org/releases/calendar`.
`mode='release'` — long format `section,key,value,unit,asOf,source` with sections `release` (one row per attribute), `event` (key = `scheduledAt`, value = `actual`), `observation` (key = `obsDate`, value = observation value, `asOf` = `vintageAt`) and `vintage` (key = `obsDate|vintageAt`). Example: `observation,2026-08-01,324.112,Index 1982-1984=100,2026-09-16T12:31:04Z,fred.csv`.

#### Help
summary `Macro release calendar with actual, prior and revised values; consensus unavailable`; description `ECO shows scheduled and released economic data by day, week or month from the FRED release calendar, the BLS release schedule and the FOMC calendar, with the actual print, the prior value and the revised prior taken from the stored observation vintages. Press 1/2/3 for day, week or month, C to switch between US and all countries, I to raise the importance filter and + / - to page to the next or previous window. Enter on a row opens the release, where every observation is listed with the exact vintage that produced it, so a revision is visible as data rather than as a footnote. Consensus, forecast dispersion and surprise are unavailable: no consensus-estimates provider is reachable in this wedge, so those columns show NO_CONSENSUS_SOURCE and are never filled with a guess.`; params: `range` ("D, W or M", example `ECO M`), `date` ("anchor day", `ECO W 2026-10-05`), `country` ("US or ALL", `CTY=ALL`), `importance` ("minimum importance 1–3", `IMP=2`), `releaseId` ("open one release", `REL=10`), `fomc` ("include FOMC meetings", `FOMC=0`); sources `['fred.calendar', 'bls.schedule', 'fed.fomc', 'fred.csv', 'bls.timeseries']`; related `['NI', 'GP', 'HP', 'BTMM', 'FED', 'WIRP']`.

#### Unavailable and reason codes
`{ field:'consensus', reason:'NO_SOURCE', detail:'NO_CONSENSUS_SOURCE: no consensus-estimates provider is reachable in the wedge (BRIEF §2); the column is never populated' }` on every run (calendar and release mode) · `{ field:'surprisePct', reason:'NO_SOURCE', detail:'NO_CONSENSUS_SOURCE: surprise requires a consensus value' }` · `{ field:'release', reason:'NO_SOURCE', detail:'unknown release id' }` when `params.releaseId` matches no `econ_releases` row · `{ field:'ECO_VALUE', reason:'NOT_APPLICABLE', detail:'release has no headline series in econ_series; actual is published as text only' }` when `econ_release_events.series_id` is null. Footer badges: `CALENDAR_STALE` (newest calendar capture older than 36 h — the daily `econCalendar` job has not run, TERM-12), `TIME_UNKNOWN` (per row, `time_known = false`), `DELAYED`/`CANCELLED` (event status). Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT` on `fred.csv` or `bls.timeseries` blanks `actual`/`prior`/`revisedPrior` with `r` set and the reason in `meta.entitlement` (ENTL-05); `PROVIDER_DOWN` on `fred.series` read-through in release mode returns stored observations with `st:'stale'` and `meta.staleness:'stale'`.

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules (shared) |
| golden payload | `packages/server/test/integration/functions/ECO.golden.test.ts` | seeded `econ_release_events` (from `fred-cal`, `fred-releases.html`, `bls-schedule.html`, `fixtures/seed/fomc-2026.json`) at the frozen clock `2026-09-15T18:41:28Z`, `range:'W'` deep-equals `ECO.default.json`; `REL=10` deep-equals `ECO.default-release.json` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals `ECO.default.csv` and `ECO.default-release.csv`; every numeric cell equals the payload value |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/ECO.test.tsx` | renders both goldens; `1`/`2`/`3` call `setParams({range})`, `C`/`I`/`F`/`T` call `setParams`, `+`/`-` call `ctx.page`; `consensus` column renders `—` with tooltip `NO_CONSENSUS_SOURCE`; `e:` live cells registered for today's events; `payload undefined` renders the skeleton |
| consensus never fabricated | `packages/server/test/integration/functions/ECO.consensus.test.ts` | every `days[].events[].consensus.v === null` and `surprisePct === null` for all 60 seeded events; `meta.unavailable` contains both entries exactly once |
| vintages and revisions | `packages/server/test/integration/functions/ECO.vintage.test.ts` | insert a second `econ_observations` vintage for `CUUR0000SA0` 2026-07-01; `knownAt` before it → `prior` = original and `revisedPrior` null; `knownAt` after → `revisedPrior` = new value, `status:'revised'`, `revisions[]` lists both vintages (STOR-06) |
| paging | `packages/server/test/unit/functions/ECO.page.test.ts` | cursor round-trip `base64url(JSON)`; `fwd` from week of 2026-09-14 → 2026-09-21, `back` → 2026-09-07; `range:'M'` shifts by calendar month with month-end clamping |
| calendar staleness | `packages/server/test/integration/functions/ECO.stale.test.ts` | newest capture aged to 48 h → `meta.staleness:'stale'` and footer note `CALENDAR_STALE`, no throw (TERM-12) |
| e2e | `packages/e2e/tests/eco-release.spec.ts` | `ECO <GO>` → week grid; `2` then `+` pages to the next week; `Enter` on the CPI row opens release detail; `PRINT` downloads a CSV whose `consensus` column is empty and `consensusReason` is `NO_CONSENSUS_SOURCE` |

---

### PORT — Portfolio Analytics

| Attribute | Value |
| --- | --- |
| Code / aliases | `PORT` / `PRT` (no `aliasParams`) |
| Tier / category | 2 / portfolio |
| Asset classes → variants | `none → default` |
| requiresSecurity / pageable / screenKind | `false` / `false` / `declarative` |
| payloadVersion | 1 |
| Files | `packages/core/src/functions/manifests/PORT.ts` · `packages/server/src/functions/PORT/resolve.ts` · `packages/web/src/screens/PORT/Screen.tsx` · `fixtures/golden/functions/PORT.default.{json,csv}` (holdings view), `fixtures/golden/functions/PORT.default-attribution.{json,csv}`, `fixtures/golden/functions/PORT.default-risk.{json,csv}` |
| Requirements | (FUNC-01) (FUNC-02) (FUNC-03) (FUNC-04) (PORT-01) (PORT-02) (PORT-03) (PORT-04) (PORT-05) (PORT-06) (PORT-07) (ANAL-07) (ANAL-08) (DATA-10) (TERM-08) (TERM-12) (ENTL-05) (API-05) (SEC-05) |

#### Params
```ts
export const PortScenarioId = z.enum([
  'UST_PARALLEL_UP_100', 'UST_PARALLEL_DN_100', 'UST_STEEPEN_50', 'EQUITY_DOWN_10', 'EQUITY_DOWN_20',
  'USD_UP_5', 'USD_DN_5', 'EPISODE_2020_COVID', 'EPISODE_2022_RATES',
]);
export const PortParams = z.object({
  portfolioId: z.number().int().positive().optional(),            // undefined = the caller's most recently updated portfolio
  view: z.enum(['holdings', 'exposure', 'attribution', 'risk']).default('holdings'),
  asOfDate: z.iso.date().optional(),                              // positions as-of date; undefined = latest positions.as_of_date
  benchmark: SecurityRefInput.optional(),                         // overrides portfolios.benchmark_instrument_id for this run
  groupBy: z.enum(['sector', 'assetClass', 'currency', 'instrument']).default('sector'),
  lookbackDays: z.number().int().min(60).max(1260).default(252),  // risk/attribution window in sessions (ANAL-07 annualisation 252)
  varMethod: z.enum(['historical', 'parametric']).default('historical'),
  varConfidence: z.enum(['95', '99']).default('95'),
  scenarios: z.array(PortScenarioId).max(9).default(['UST_PARALLEL_UP_100', 'EQUITY_DOWN_10', 'USD_UP_5', 'EPISODE_2022_RATES']),
});
```
#### Argument grammar
`positional [{ name:'view', type:'enum', values:['holdings','exposure','attribution','risk'], optional:true }]`, `keyed { P: { name:'portfolioId', type:'int' }, DATE: { name:'asOfDate', type:'date' }, BM: { name:'benchmark', type:'security' }, GRP: { name:'groupBy', type:'enum', values:['sector','assetClass','currency','instrument'] }, N: { name:'lookbackDays', type:'int' }, VAR: { name:'varMethod', type:'enum', values:['historical','parametric'] }, CONF: { name:'varConfidence', type:'enum', values:['95','99'] }, SCEN: { name:'scenarios', type:'string' } }`, no `rest` (`SCEN` takes a comma-separated list of `PortScenarioId`).
Examples: `PORT` → `{ view:'holdings', groupBy:'sector', lookbackDays:252, varMethod:'historical', varConfidence:'95' }` · `PORT ATTRIBUTION P=1 N=504` → `{ view:'attribution', portfolioId:1, lookbackDays:504 }` · `PORT RISK BM=SPY US Equity CONF=99 SCEN=EQUITY_DOWN_20,USD_UP_5` → `{ view:'risk', benchmark:{ ref:'SPY US Equity' }, varConfidence:'99', scenarios:['EQUITY_DOWN_20','USD_UP_5'] }`.

#### Payload
```ts
export type PortView = 'holdings' | 'exposure' | 'attribution' | 'risk';
export type PortReconStatus = 'ok' | 'unresolved' | 'duplicate' | 'price_missing';

export interface PortHoldingRow {
  positionId: number; instrumentId: number | null; key: string | null;            // 'AAPL US Equity'; null for cash / unresolved
  name: string; rawIdentifier: string; assetClass: AssetClass | null; marketSector: MarketSector | null;
  gicsSector: string | null; currency: string; isCash: boolean; lotCount: number;
  quantity: number; costPrice: number | null; costCurrency: string | null; tradeDate: string | null; accrued: number;
  px: ValueCell; fxRate: ValueCell;                                                // PX_LAST and FX_USD, both live where a subject exists
  marketValue: ValueCell; weight: ValueCell; dayPnl: ValueCell; unrealisedPnl: ValueCell;
  benchWeight: number | null; activeWeight: number | null;                         // null when there is no benchmark
  reconStatus: PortReconStatus; subject: string | null; provIdx: number;
}
export type PortPayload = {
  variant: 'default';
  view: PortView;
  portfolio: { portfolioId: number; firmId: number; name: string; baseCurrency: string;
               benchmark: { instrumentId: number; key: string; name: string; source: 'portfolio' | 'param' } | null;
               asOfDate: string; positionCount: number; updatedAt: string };
  totals: { marketValue: ValueCell; costBasis: number | null; unrealisedPnl: ValueCell; dayPnl: ValueCell;
            cash: number; accrued: number; longMv: number; shortMv: number; grossMv: number; netMv: number;
            pricedWeight: number };                                                // fraction of gross MV that carries a price
  holdings: PortHoldingRow[];
  exposure: { groupBy: 'sector' | 'assetClass' | 'currency' | 'instrument';
              rows: Array<{ key: string; label: string; marketValue: number; weight: number;
                            benchWeight: number | null; activeWeight: number | null; count: number }>;
              currency: Array<{ ccy: string; marketValue: number; weight: number; fxRate: ValueCell; fxDate: string }>;
              engine: { name: 'portfolio/exposure'; version: string } } | null;
  attribution: { method: 'brinson_fachler'; groupBy: 'sector'; period: { from: string; to: string; sessions: number };
                 rows: Array<{ key: string; label: string; portWeight: number; benchWeight: number;
                               portReturn: number; benchReturn: number;
                               allocation: number; selection: number; interaction: number; total: number }>;
                 total: { portReturn: number; benchReturn: number; active: number;
                          allocation: number; selection: number; interaction: number };
                 unattributed: { weight: number; total: number; reason: 'FI_ATTRIBUTION_UNAVAILABLE' | 'PRICE_MISSING' } | null;
                 engine: { name: 'portfolio/attribution'; version: string; inputsHash: string } } | null;
  risk: { lookbackDays: number; sessions: number; conventions: { returns: 'simple'; priceBasis: 'close'; adjust: 'price';
                                                                 annualisation: 252; volWindow: 30 };
          volPct: number | null; benchVolPct: number | null; trackingErrorPct: number | null;
          beta: number | null; corr: number | null; r2: number | null;
          sharpe: number | null; informationRatio: number | null; maxDrawdownPct: number | null;
          var: { method: 'historical' | 'parametric'; confidence: 95 | 99; horizonDays: 1;
                 valuePct: number | null; valueCcy: number | null;
                 backtest: { windowSessions: number; exceptions: number; expected: number } | null };
          varMonteCarlo: null;                                                     // VAR_MC_NOT_IN_V1
          factorExposures: null;                                                    // NO_FACTOR_MODEL
          scenarios: Array<{ id: string; label: string; method: 'shock' | 'episode'; detail: string;
                             pnlCcy: number | null; pnlPct: number | null; unavailableReason: string | null }>;
          engine: { name: 'portfolio/risk'; version: string; inputsHash: string } } | null;
  recon: { importId: number | null; channel: 'upload' | 'file_drop' | 'api' | 'manual' | null; uploadedAt: string | null;
           status: 'accepted' | 'partial' | 'rejected' | null;
           rowsTotal: number; rowsOk: number; rowsError: number;
           errors: Array<{ row: number; identifier: string; column: string; reason: string }>;
           matched: number; added: number; removed: number;
           quantityDiffs: Array<{ instrumentId: number; before: number; after: number }> };
  confidentiality: { firmOnly: true; note: 'PORT-07: firm-isolated; never leaves the tenant' };
  notes: string[];                                                                  // 'NO_BENCHMARK', 'PRICE_MISSING', 'FI_ATTRIBUTION_UNAVAILABLE' …
};
```
Field ids introduced by this entry (must be added to `core/fields/dictionary.ts` and `providers/licences.ts` per FUNCTIONS.md §1.8 step 6, `fieldClass:'portfolio'`, `sources: { assetClass:'*', sourceId:'internal.user', endpoint:'positions', providerPath:'core/analytics/portfolio' }`, `updateFreq:'realtime'` for the first four and `'daily'` for the rest, `pit:false`, `since:'2026.09.1'`) — see "additions required". **`PORT_MV`, `PORT_WEIGHT`, `PORT_PNL_1D`, `PORT_ACTIVE_WEIGHT` and `PORT_CONTRIB_TE` are not new**: they are the five portfolio-class ids API.md §7 L1111 already declares, and PORT is their producer. Only `PORT_UNREAL_PNL`, `PORT_BETA` and `PORT_VAR` are additions. An earlier draft of this entry coined `PORT_MKT_VALUE`, `PORT_DAY_PNL` and `PORT_TRACK_ERR` for quantities that already had ids; those spellings are withdrawn, because two ids for one quantity breaks API.md §7 rule 2 (ids never change meaning) and would leave the dictionary's `PORT_MV`/`PORT_PNL_1D`/`PORT_CONTRIB_TE` without a producer:

| id | label | type / unit | decimals | derivation | assetClasses |
| --- | --- | --- | --- | --- | --- |
| `PORT_MV` | Market value | number / ccy | 2 | `quantity × PX_LAST × FX_USD → base currency` (cash: `quantity`) | * |
| `PORT_WEIGHT` | Portfolio weight | number / pct | 2 | `PORT_MV / totals.grossMv` | * |
| `PORT_PNL_1D` | Day P&L | number / ccy | 2 | `quantity × CHG_NET_1D × FX_USD` | * |
| `PORT_UNREAL_PNL` | Unrealised P&L | number / ccy | 2 | `quantity × (PX_LAST − costPrice) × FX_USD` | * |
| `PORT_ACTIVE_WEIGHT` | Active weight | number / pct | 2 | `PORT_WEIGHT − benchWeight` (`index_members.weight`) | * |
| `PORT_BETA` | Portfolio beta | number / ratio | 3 | OLS slope of portfolio returns on benchmark returns, `lookbackDays` sessions (`core/analytics/stats`) | * |
| `PORT_CONTRIB_TE` | Contribution to tracking error | number / pct | 2 | on a position row: that position's contribution to tracking error; on the totals row: stdev of (portfolio − benchmark) daily returns × √252 × 100, which the row contributions sum to | * |
| `PORT_VAR` | Value at Risk | number / pct | 2 | 1-day VaR at `varConfidence` by `varMethod` (`core/analytics/portfolio/risk.ts`) | * |

#### Data dependencies
| Kind | Items |
| --- | --- |
| Tables (DATA_MODEL.md) | `portfolios`, `positions`, `lots`, `portfolio_imports` (all RLS-scoped by `firm_id`, DATA_MODEL §15 / PORT-07), `instruments`, `issues`, `issuers`, `entity_classifications` + `classification_codes` (scheme `GICS`, as-of `ctx.asOf`), `bars_daily` (return series, adjust policy `price`), `quote_snapshots` (plant warm start), `fx_rates` (`frankfurter` then `yahoo.chart`), `indices` + `index_members` (benchmark weights and sector returns), `etf_holdings` (when the benchmark is an ETF), `curve_points` (`UST_PAR` for the curve-shift scenarios), `govt_terms` (bond scenario repricing inputs) |
| Data services (§1.4.2) | `data.portfolio.get`, `data.portfolio.positions`, `data.portfolio.recon`, `data.reference.instrument`, `data.reference.resolve`, `data.reference.members`, `data.historical.bars`, `data.snapshot.fields`, `data.curves.points`, `plant.subjectFor`, `plant.snapshotMany`, `plant.ensureHot` |
| Read-through (`providers.ensure`) | None for holdings — portfolio data is `internal.user` and is never sent to or fetched from a provider (PORT-07). `('yahoo.daily', instrumentKey, { maxAgeMs: 86_400_000 })` only for a held instrument with fewer than `lookbackDays` rows in `bars_daily` and only in the `attribution`/`risk` views; `('sec.nport', benchmarkCik, { maxAgeMs: 86_400_000 })` when the benchmark is an ETF with no `etf_holdings` row |
| Engines (`core/analytics`) | `portfolio/exposure@1.0.0` (`exposure` view), `portfolio/attribution@1.0.0` Brinson–Fachler (PORT-03), `portfolio/risk@1.0.0` ex-post tracking error, historical/parametric VaR, scenario shocks (PORT-04/05/06), `stats@1.0.0` (returns, vol, beta, drawdown, Sharpe/IR — ANAL-07 conventions of Tier 1 §0.6). Every engine is registered through `ctx.engines.add({ name, version, inputsHash })` (ANAL-08) |
| Subjects (live) | `q:<instrumentId>` for every priced, non-cash holding; `q:<benchmarkInstrumentId>`; FX lines are read from `fx_rates` (daily) and are not subscribed |
| Field ids (`fieldIds(assetClass)`) | `default: [PX_LAST, CHG_NET_1D, CHG_PCT_1D, PX_CLOSE_1D, FX_USD, PORT_MV, PORT_WEIGHT, PORT_PNL_1D, PORT_UNREAL_PNL, PORT_ACTIVE_WEIGHT, PORT_BETA, PORT_CONTRIB_TE, PORT_VAR]` |

#### Resolver
Single `resolve` (`assetClasses: 'none'`, no variants). Every query runs in the request transaction with `app.user_id`/`app.firm_id` set, so a portfolio of another firm is simply not visible (PORT-07, DATA_MODEL §15).
1. `pf = params.portfolioId ? await ctx.data.portfolio.get(params.portfolioId) : firstOf(await listPortfolios(ctx.user.firmId) ordered by updated_at DESC)`. No row (or another firm's row, which RLS hides) → `ctx.unavailable.add({ field:'portfolio', reason:'NO_SOURCE', detail:'NO_PORTFOLIO: no portfolio is visible to this user; create one or import positions (PORT-01)' })` and return `holdings: []`, `totals` all-null, `exposure/attribution/risk: null`.
2. `asOfDate = params.asOfDate ?? max(positions.as_of_date) for the portfolio`; `positions = await ctx.data.portfolio.positions(pf.portfolioId, asOfDate)`; `lots = grouped by (instrumentId, lotId)` for `lotCount` and the weighted `costPrice` (PORT-02 lot-level cost basis). `ctx.prov.add({ sourceId:'internal.user', provenanceId: pf.provenanceId ?? importProvenanceId, capturedAt: uploadedAt, sourceTs: null, st:'closed', tier:'eod' })` once; every holding cites that `provIdx` for `quantity`/`costPrice`.
3. Pricing: `subjects = positions.filter(p => p.instrumentId && !p.isCash).map(p => plant.subjectFor(p.instrumentId))`; `plant.ensureHot(subjects)`; `states = plant.snapshotMany(subjects)`. `px = cellFromState(ctx, states.get(subject), 'PX_LAST', subject)` and the day change from `CHG_NET_1D` (Tier 1 §0.4 rules 1 and 2 — the resolver never calls `providers.ensure` for a quote, so a cold name is `pending` and fills from the WS `snap`). A position whose `instrumentId` is null gets `reconStatus:'unresolved'` and `px = { v:null, st:'na', r:undefined, provIdx:-1 }`; a resolved instrument with no quote **and** no `bars_daily` close in the last 10 sessions gets `reconStatus:'price_missing'`.
4. FX (PORT-02 multi-currency): for each distinct `currency ≠ pf.baseCurrency`, `fxRate` from `fx_rates` for `(currency, baseCurrency, ≤ asOfDate, source 'frankfurter' preferred over 'yahoo.chart')` as a stored-value cell (`st:'closed'`, §0.4 rule 3); a missing pair → `fxRate = { v:null, st:'na' }`, the holding is excluded from `totals` and `notes` gains `FX_MISSING`. `marketValue = quantity × px.v × fxRate.v` (cash: `quantity × fxRate.v`), `dayPnl = quantity × CHG_NET_1D × fxRate.v`, `unrealisedPnl = quantity × (px.v − costPrice) × fxRate.v` (null when `costPrice` is null). All four are derived cells citing the `provIdx` of `px` (§0.4 rule 4).
5. `totals`: `grossMv = Σ|marketValue|`, `netMv = Σ marketValue`, `longMv`/`shortMv` by sign, `cash = Σ marketValue where isCash`, `accrued = Σ accrued`, `pricedWeight = Σ|marketValue| of rows with px.v ≠ null / grossMv`. `weight = marketValue / grossMv` per holding.
6. Benchmark: `bm = params.benchmark ? await ctx.data.reference.resolve(params.benchmark) : pf.benchmarkInstrumentId`. When set, `benchWeights = await ctx.data.reference.members(bm.instrumentId, asOfDate)` (SPX via `index_members`, an ETF benchmark via `etf_holdings`); `benchWeight`/`activeWeight` per holding; a held name that is **not** in the benchmark gets `benchWeight: 0` (never `null`), so `activeWeight` equals the full position weight. No benchmark at all → `benchWeight`/`activeWeight` null, `attribution: null`, `notes: ['NO_BENCHMARK']`, `ctx.unavailable.add({ field:'attribution', reason:'NOT_APPLICABLE', detail:'NO_BENCHMARK: the portfolio has no benchmark; set one on the portfolio or pass BM=' })`.
7. `view === 'exposure'`: `exposure = portfolioExposure({ holdings, groupBy: params.groupBy, gics })` from `core/analytics/portfolio/exposure.ts`; `gicsSector` from `entity_classifications` (scheme `GICS`, level 1) as-of `ctx.asOf`, unknown → group `UNCLASSIFIED`. `currency[]` groups by holding currency with the same `fxRate` cell. `ctx.engines.add({ name:'portfolio/exposure', version:'1.0.0', inputsHash: sha256(canonicalJson({ portfolioId, asOfDate, groupBy, keys, weights })) })`.
8. `view === 'attribution'`: `period = [session(asOfDate − lookbackDays), asOfDate]`. Portfolio and benchmark sector returns come from `data.historical.bars(id, { start, end, periodicity:'D', adjust:'price' })` for every held instrument and every benchmark member, buy-and-hold weighted at the period start. `attribution = brinsonFachler({ portWeights, benchWeights, portReturns, benchReturns })` from `core/analytics/portfolio/attribution.ts` — per sector `allocation = (wP − wB)(rB − rBtotal)`, `selection = wB(rP − rB)`, `interaction = (wP − wB)(rP − rB)`, `total = allocation + selection + interaction`. Positions in `govt`, `option` or `future` asset classes and any row with `reconStatus:'price_missing'` go to `unattributed` with reason `FI_ATTRIBUTION_UNAVAILABLE` / `PRICE_MISSING`: `ctx.unavailable.add({ field:'attribution.fixedIncome', reason:'NO_SOURCE', detail:'FI_ATTRIBUTION_UNAVAILABLE: curve/spread/carry attribution needs evaluated bond prices; DATA-04 is out of scope in this wedge (BRIEF §1), so fixed-income positions are reported as one unattributed bucket' })`. Currency attribution is reported inside `exposure.currency` only; `ctx.unavailable.add({ field:'attribution.currency', reason:'NOT_APPLICABLE', detail:'CCY_ATTRIBUTION_UNAVAILABLE: no forward points source; currency effect is shown as exposure, not as an attribution term' })`. Engine entry `{ name:'portfolio/attribution', version:'1.0.0', inputsHash }`.
9. `view === 'risk'`: build the daily portfolio return series over `lookbackDays` sessions from the same bars at fixed current weights; `volPct`, `beta`, `corr`, `r2`, `sharpe`, `informationRatio`, `maxDrawdownPct` from `core/analytics/stats` with the Tier 1 §0.6 conventions echoed into `risk.conventions`; `trackingErrorPct` = stdev of active returns × √252 × 100. `var` from `core/analytics/portfolio/risk.ts`: `historical` = the `(100 − confidence)`-th percentile of the return series; `parametric` = `z(confidence) × dailyVol`. `backtest` counts realised exceptions over the same window against the rolling VaR and reports `expected = sessions × (1 − confidence/100)` (PORT-06 documented assumptions and exception backtesting). `varMonteCarlo: null` with `ctx.unavailable.add({ field:'risk.varMonteCarlo', reason:'NOT_APPLICABLE', detail:'VAR_MC_NOT_IN_V1: core/analytics/portfolio/risk.ts implements historical and parametric VaR only' })`; `factorExposures: null` with `ctx.unavailable.add({ field:'risk.factorExposures', reason:'NO_SOURCE', detail:'NO_FACTOR_MODEL: no commercial multi-factor risk model is licensable in this wedge; tracking error, beta and contribution are computed ex-post from returns instead (PORT-04 partial)' })`.
10. Scenarios (PORT-05), each entry of `params.scenarios`: `UST_PARALLEL_UP_100` / `UST_PARALLEL_DN_100` / `UST_STEEPEN_50` reprice `govt` holdings through `core/analytics/bond/risk` DV01 against `curve_points('UST_PAR', asOfDate)` and apply `−beta × Δy × equityDuration = 0` to equities (equities are unaffected by construction, stated in `detail`); `EQUITY_DOWN_10` / `EQUITY_DOWN_20` apply `beta × shock` per equity/etf/index holding; `USD_UP_5` / `USD_DN_5` apply the move to every non-base-currency holding; `EPISODE_2020_COVID` (2020-02-19 → 2020-03-23) and `EPISODE_2022_RATES` (2022-01-03 → 2022-10-14) replay the realised return of each held instrument over that window. A holding whose `bars_daily` does not cover an episode window contributes `null` and the scenario row carries `unavailableReason: 'EPISODE_WINDOW_UNAVAILABLE'` naming the instruments (the seeded universe has five years of AAPL bars, so `EPISODE_2020_COVID` is available for AAPL and unavailable for instruments seeded from the quarterly `max` series). Engine entry `{ name:'portfolio/risk', version:'1.0.0', inputsHash: sha256(canonicalJson({ portfolioId, asOfDate, lookbackDays, varMethod, varConfidence, scenarios, weights })) }`.
11. `recon` from `ctx.data.portfolio.recon(pf.portfolioId)` — the latest `portfolio_imports` row's `rows_total/rows_ok/rows_error`, `errors[]` and `reconciliation{matched, added, removed, quantityDiffs}` (PORT-01). No import row (positions written through `PUT /portfolios/:portfolioId/positions`) → `importId: null`, `channel: null`, counts zero.
12. Return the payload with `confidentiality: { firmOnly: true, note: 'PORT-07: firm-isolated; never leaves the tenant' }`. `views` other than the requested one are `null` — the screen re-runs with `setParams({ view })` so an unrequested analytic is never computed or logged.
Budget: holdings view 3 DB round-trips (portfolio+positions+lots, classifications, fx) plus one plant snapshot, zero provider calls; < 300 ms p95. Exposure 4; attribution and risk 5 round-trips plus one bar read per distinct instrument (batched into a single `bars_daily` query over `instrument_id = ANY(...)`); < 1.2 s p95 for the seeded 12-lot portfolio against a 503-name benchmark.

#### Live
`{ subjects: [...holdings.filter(h => h.subject).map(h => h.subject!), 'q:' + portfolio.benchmark.instrumentId].filter(unique), fields: ['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D'], conflationMs: 2000 }` (null when `holdings` is empty or every row is cash). `grid#holdings` sets `live.subjectOf = row => row.subject`; `px`, `dayPnl`, `marketValue`, `weight` and `unrealisedPnl` carry `Cell.live = { subject, field:'PX_LAST' }` so `web/grid/cellRegistry` recomputes the derived cells from the delta (`marketValue = quantity × v × fxRate.v`) and flashes them without a React render (TERM-08). `totals.marketValue`/`totals.dayPnl` are registered against the same subject set and recomputed client-side as the sum of the live row values.

#### Screen
```
holdings (view = 'holdings')
┌ PORT · Demo Long · 2026-09-15 · USD ─────────────────────────────────────────────┐
│ tabs#view  [1 Holdings] [2 Exposure] [3 Attribution] [4 Risk]                     │
│ badges#mode [bench SPX Index] [as-of 2026-09-15] [GRP sector] [PORT-07 FIRM ONLY] │
│ kv#totals  market value (ccy 2dp) · day P&L (ccy, dir up/down) · unrealised P&L    │
│            · gross / net / long / short · cash · accrued · priced 100.0%          │
│ grid#holdings  frozenColumns 2, groupBy 'gicsSector'                              │
│   key | name | qty (shares) | cost (px) | last (live px) | ccy | fx (px 4dp)       │
│   | mkt value (live ccy) | wt% (live pct) | bench wt% | active wt% | day P&L       │
│   | unreal P&L | recon badge                                                      │
│ text#recon  import 7 · 12 rows · 12 ok · 0 error · matched 12 / added 0 / removed 0│
│ footer: sources ['Client portfolio (internal.user, confidential)','Cboe delayed    │
│         quotes','Yahoo Finance daily bars','ECB reference rates (frankfurter)']    │
└──────────────────────────────────────────────────────────────────────────────────┘
exposure (view = 'exposure')
│ grid#exposure  group | mkt value | weight% | bench wt% | active wt% | n            │
│ table#currency ccy | mkt value | weight% | fx rate | fx date                       │
attribution (view = 'attribution')
│ badges#reason [FI_ATTRIBUTION_UNAVAILABLE] [CCY_ATTRIBUTION_UNAVAILABLE]           │
│ grid#attribution sector | wP% | wB% | rP% | rB% | alloc bp | sel bp | inter bp     │
│                  | total bp        (total row pinned, bold; unattributed row muted)│
risk (view = 'risk')
│ kv#risk  vol% · bench vol% · tracking error% · beta · corr · R² · Sharpe · IR      │
│          · max drawdown% · VaR 95 1d (% and ccy) · backtest 11 exceptions / 12.6   │
│ badges#reason [NO_FACTOR_MODEL] [VAR_MC_NOT_IN_V1]                                 │
│ grid#scenarios id | label | method | detail | P&L (ccy) | P&L% | reason            │
```
Title `PORT · <portfolio.name> · <asOfDate> · <baseCurrency>`; subtitle `<view> · bench <benchmark.key ?? '—'> · <lookbackDays> sessions`. `initialFocus:'holdings'` (`'exposure'`, `'attribution'`, `'scenarios'` per view). Skeleton while `payload === undefined`: the tabs row, a `kv#totals` with 6 muted rows and `grid#holdings` with 12 muted rows. `meta.unavailable` renders as the `badges#reason` row and, per column, as `—` with the reason as tooltip (`factorExposures`, `varMonteCarlo`, fixed-income rows); `meta.entitlement` denials on `PX_LAST` blank `last`, `mkt value`, `wt%` and both P&L columns with `—` and the reason, and `totals.pricedWeight` drops accordingly (ENTL-05); `meta.staleness:'stale'` (a delayed quote older than `3 × expectedIntervalMs`) shows the stale glyph on `badges#mode` and on each affected cell (TERM-12). The `PORT-07 FIRM ONLY` badge (tone `blocked`) is always present and is repeated in the CSV header.

#### Keyboard
| Key | When | Action id | Effect |
| --- | --- | --- | --- |
| `1`…`4` | always | `tab-view` | `ctx.setParams({ view })` in tab order: holdings, exposure, attribution, risk (usage `fn.param`) |
| `P` | always | `pick-portfolio` | `ctx.prompt('text', { label:'Portfolio' })` → `setParams({ portfolioId })` |
| `B` | always | `set-benchmark` | `ctx.prompt('security', { label:'Benchmark' })` → `setParams({ benchmark })` |
| `D` | always | `set-as-of-date` | `ctx.prompt('date', { label:'Positions as of' })` → `setParams({ asOfDate })` |
| `R` | grid (`exposure`) | `cycle-group-by` | `sector → assetClass → currency → instrument → sector` via `setParams({ groupBy })` |
| `V` | always | `cycle-var` | `historical/95 → historical/99 → parametric/95 → parametric/99` via `setParams({ varMethod, varConfidence })` |
| `+` / `-` | always | `longer-lookback` / `shorter-lookback` | `setParams({ lookbackDays: clamp(lookbackDays ± 126, 60, 1260) })` |
| `S` | grid (`scenarios`) | `edit-scenarios` | `ctx.prompt('text', { label:'Scenarios', initial: scenarios.join(',') })` → `setParams({ scenarios })` |
| `Enter` | grid (`holdings`) | `open-des` | `ctx.navigate(row.key + ' DES')` (no-op on a cash or unresolved row) |
| `Shift+Enter` | grid (`holdings`) | `open-des-next` | `ctx.navigateNext(row.key + ' DES')` |
| `G` | grid (`holdings`) | `open-gp` | `ctx.navigate(row.key + ' GP 1Y')` |
| `Enter` | grid (`attribution`) | `drill-sector` | `ctx.setParams({ view:'exposure', groupBy:'instrument' })` focused on the sector's rows |

#### CSV
`filename = 'PORT_' + portfolio.name.replace(/ /g,'_') + '_' + view.toUpperCase() + '_' + portfolio.asOfDate.replace(/-/g,'') + '.csv'`; `csvColumns` is `null` (payload-dependent). Every export carries the extra header line `# confidential: client portfolio data, firm <firmId> only (PORT-07)` before `# source:`.
`view='holdings'` — wide: `key,name,rawIdentifier,assetClass,gicsSector,currency,quantity,costPrice,costCurrency,tradeDate,px,fxRate,marketValue,weight,benchWeight,activeWeight,dayPnl,unrealisedPnl,accrued,lotCount,reconStatus`, one row per `holdings[]` at full precision (`ValueCell` contributes `v` only), followed by `section`-prefixed rows for `totals` and `recon` per §1.6 rule 3. Example: `AAPL US Equity,Apple Inc,AAPL US,equity,Information Technology,USD,1200,187.42,USD,2024-03-11,245.31,1,294372,0.1832,0.0712,0.112,1884,69468,0,2,ok`.
`view='exposure' | 'attribution' | 'risk'` — long format `section,key,value,unit,asOf,source` with sections `portfolio`, `totals`, `exposure`, `currency`, `attribution` (key = `sector|term`, e.g. `Information Technology|selection`), `attributionTotal`, `unattributed`, `risk`, `var`, `backtest`, `scenario`, `unavailable` (one row per `meta.unavailable` entry so the reason travels with the file). Example: `attribution,Information Technology|selection,0.0043,ratio,2026-09-15,internal.derived`.

#### Help
summary `Portfolio holdings, exposure, Brinson attribution and ex-post risk, firm-isolated`; description `PORT prices your imported positions live, shows exposure by sector, asset class or currency against the portfolio's benchmark, decomposes active return with a Brinson-Fachler attribution, and reports ex-post risk: volatility, tracking error, beta, drawdown and one-day VaR with an exception backtest, plus parallel and steepening curve shifts, equity and FX shocks and two historical-episode replays. Press 1 to 4 for the four views, B to change the benchmark, D to price a different as-of date, V to cycle the VaR method and confidence, and + / - to lengthen or shorten the risk window. Multi-factor risk exposures and Monte Carlo VaR are unavailable: there is no licensable factor model in this wedge, so risk is measured ex-post from returns. Fixed-income positions are grouped into one unattributed bucket because curve, spread and carry attribution needs evaluated bond prices that this build does not source. Portfolio data is tenant-isolated: it is never sent to a data provider and is visible only inside your firm.`; params: `portfolioId` ("which portfolio", example `P=1`), `view` ("holdings, exposure, attribution or risk", `PORT RISK`), `asOfDate` ("positions as of", `DATE=2026-09-15`), `benchmark` ("benchmark security", `BM=SPX Index`), `groupBy` ("sector, assetClass, currency or instrument", `GRP=currency`), `lookbackDays` ("60–1260 sessions", `N=504`), `varMethod` ("historical or parametric", `VAR=parametric`), `varConfidence` ("95 or 99", `CONF=99`), `scenarios` ("comma-separated scenario ids", `SCEN=EQUITY_DOWN_20,USD_UP_5`); sources `['internal.user', 'cboe.quotes', 'yahoo.chart', 'frankfurter', 'sec.archives', 'ssga.holdings', 'wiki.sp500', 'internal.derived']`; related `['W', 'QM', 'MEMB', 'HDS', 'GP', 'BTMM']`.

#### Unavailable and reason codes
`{ field:'portfolio', reason:'NO_SOURCE', detail:'NO_PORTFOLIO: no portfolio is visible to this user; create one or import positions (PORT-01)' }` · `{ field:'attribution', reason:'NOT_APPLICABLE', detail:'NO_BENCHMARK: the portfolio has no benchmark; set one on the portfolio or pass BM=' }` · `{ field:'attribution.fixedIncome', reason:'NO_SOURCE', detail:'FI_ATTRIBUTION_UNAVAILABLE: …' }` · `{ field:'attribution.currency', reason:'NOT_APPLICABLE', detail:'CCY_ATTRIBUTION_UNAVAILABLE: …' }` · `{ field:'risk.factorExposures', reason:'NO_SOURCE', detail:'NO_FACTOR_MODEL: …' }` (PORT-04 partial) · `{ field:'risk.varMonteCarlo', reason:'NOT_APPLICABLE', detail:'VAR_MC_NOT_IN_V1: …' }` (PORT-06 partial) · `{ field:'PX_LAST', reason:'NO_SOURCE', detail:'PRICE_MISSING: no quote and no daily close in the last 10 sessions for <key>' }` per affected holding · `{ field:'instrumentId', reason:'NO_SOURCE', detail:'UNRESOLVED_IDENTIFIER: "<rawIdentifier>" did not resolve to an instrument; see the import report' }` per unresolved row · `{ field:'FX_USD', reason:'NO_SOURCE', detail:'FX_MISSING: no fx_rates row for <ccy>/<base> on or before <asOfDate>' }` · per-scenario `unavailableReason: 'EPISODE_WINDOW_UNAVAILABLE'` when `bars_daily` does not cover the episode. Screen/footer notes: `NO_BENCHMARK`, `PRICE_MISSING`, `FX_MISSING`, `FI_ATTRIBUTION_UNAVAILABLE`, `EPISODE_WINDOW_UNAVAILABLE`, `PORT-07 FIRM ONLY`. Entitlement: `NO_FIRM_ENTITLEMENT`/`NO_USER_ENTITLEMENT`/`NOT_ENTITLED_TIER` on `cboe.quotes` blanks `px` and every cell derived from it with `r` set; an `eod`-only user (`eod@demo`) sees `PX_OFFICIAL_CLOSE`-based valuations with `SOURCE_TIER_CAP` in `meta.entitlement` and `st:'closed'` (ENTL-05). Export with any denied field is refused before `toCsv` runs (§1.4.4, 403 `ENTITLEMENT_DENIED`); `PROVIDER_DOWN` on `cboe.quotes` leaves the last values with `st:'stale'` and `meta.staleness:'stale'` (TERM-12).

#### Tests
| Test | File | Asserts |
| --- | --- | --- |
| manifest invariants | `packages/core/test/functions/manifests.test.ts` | §1.2 rules (shared) |
| golden payload | `packages/server/test/integration/functions/PORT.golden.test.ts` | seeded portfolio `Demo Long` (12 lots, `fixtures/seed/workspaces.json`) priced from `cboe-quote-AAPL.json`, `cboe-spx`, `yahoo-chart-events`, `frankfurter` at the frozen clock `2026-09-15T18:41:28Z` deep-equals `PORT.default.json`; `view:'attribution'` equals `PORT.default-attribution.json`; `view:'risk'` equals `PORT.default-risk.json` |
| csv parity | `packages/core/test/functions/csv.test.ts` | `writeCsv(toCsv(golden))` equals the three `.csv` goldens; every numeric cell equals the payload value; the `# confidential:` header line is present |
| parity | `packages/server/test/parity/fn-parity.test.ts` | JSON = CSV = WS snapshot at a frozen clock (API-05) |
| screen | `packages/web/test/screens/PORT.test.tsx` | renders all three goldens; `1`…`4` call `setParams({view})`, `B`/`D`/`P` open prompts, `V` cycles VaR, `+`/`-` change `lookbackDays`; live cells registered for every `q:` holding subject; `factorExposures` renders `—` with tooltip `NO_FACTOR_MODEL`; `payload undefined` renders the skeleton |
| tenant isolation | `packages/server/test/integration/functions/PORT.isolation.test.ts` | `pm@demo` (firm `Demo Capital`) running `PORT P=<Other Desk portfolio>` sees `NO_PORTFOLIO` and zero rows; the RLS session variable removal makes the same query throw; no provider call is issued with any holding identifier (PORT-07, SEC-05) |
| attribution golden | `packages/server/test/integration/functions/PORT.attribution.test.ts` | Brinson–Fachler terms sum to `total.active` within 1e-9; a synthetic two-sector portfolio reproduces the hand-computed allocation/selection/interaction of `fixtures/golden/analytics/brinson.json` (ANAL-09); `govt` rows land in `unattributed` with `FI_ATTRIBUTION_UNAVAILABLE` |
| risk and VaR | `packages/server/test/integration/functions/PORT.risk.test.ts` | historical VaR equals the 5th percentile of the computed return series; parametric equals `1.645 × dailyVol` at 95 and `2.326 × dailyVol` at 99; `backtest.expected === sessions × 0.05`; `varMonteCarlo === null` with the reason; `factorExposures === null` with `NO_FACTOR_MODEL` |
| scenarios | `packages/server/test/unit/functions/PORT.scenarios.test.ts` | `EQUITY_DOWN_10` P&L equals `Σ beta × −0.10 × marketValue`; `UST_PARALLEL_UP_100` equals `−Σ DV01 × 100` for the seeded Treasuries; an episode window outside `bars_daily` yields `pnlCcy: null` with `EPISODE_WINDOW_UNAVAILABLE` |
| reconciliation | `packages/server/test/integration/functions/PORT.recon.test.ts` | a CSV import with one bad identifier and one duplicate lot yields `recon.status:'partial'`, `rowsError:1`, an `errors[]` entry naming the column, `reconStatus` `unresolved`/`duplicate` on the affected holdings and `PRICE_MISSING`/`UNRESOLVED_IDENTIFIER` in `meta.unavailable` (PORT-01) |
| reproducibility | `packages/server/test/integration/functions/PORT.reproducible.test.ts` | two runs with the same explicit `asOf` produce identical `engines[].inputsHash` and identical risk/attribution numbers (ANAL-08) |
| e2e | `packages/e2e/tests/port-import.spec.ts` | upload a 12-row CSV through `POST /portfolios/:portfolioId/import`, then `PORT <GO>`: holdings priced and flashing, `3` shows attribution with the `FI_ATTRIBUTION_UNAVAILABLE` badge, `4` shows VaR, `PRINT` downloads the holdings CSV with the confidentiality header |
