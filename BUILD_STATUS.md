# Build status

Phase-by-phase build of the terminal. Each work package in `docs/WORKPLAN.md` is one commit; the
commit message names what landed. `git log --oneline` is the source of truth for what is done.

## Packages

| WP | Scope | State |
| --- | --- | --- |
| WP-01 | Monorepo, 16 migrations / 154 tables, shared types, test harness | merged |
| WP-02 | Core analytics, calendars, day counts, corporate actions | merged |
| WP-03 | Symbology, command line, ranking, formula language | merged |
| WP-04 | Security master, bitemporal writes, data services | merged |
| WP-05 | Provider adapters, replay store, provenance, ingest runtime | merged |
| WP-06 | Quote model, ticker plant, conflator, WebSocket gateway | merged |
| WP-07 | Entitlements, auth, access log, quotas, compliance | merged |
| WP-08 | Function runner, REST routes, export, search, observability | merged |
| WP-09 | Tier 1 functions, news, messaging, alerts | merged, with open defects below |
| WP-10 | Tier 2 functions, fundamentals ingest, portfolios | merged |
| WP-11 | Tier 3 functions, curve/rate/econ ingest | merged |
| WP-12 | Web shell, keyboard, command line, screen renderer | merged |
| WP-13 | LiveGrid, SDK live client, subscriptions, quote cache, realtime bridge | merged; the wiring gap below closed in backlog tier 1 |
| WP-14 | Chart engine, 12 series types, 22 studies, streaming, annotations | merged; the dead-module and gapped-study findings below closed in backlog tier 2 |
| WP-15 | Seed, fixtures, replay harness, parity, composition root, e2e | **merged** — part 2 added the 8 Playwright specs and regenerated `docs/TRACEABILITY.md` |

6,321 tests across 277 files, plus 47 Playwright tests that `npm test` does not run. The suite is
ten vitest projects; `server-seed` owns its own database and is the only one that seeds (see below),
and `packages/e2e` is Playwright and is not run by `npm test` at all. Measured at the close of the
backlog: two consecutive `npm test` runs green in 284.2 s and 285.5 s of reported duration against
285 s and 286 s of wall clock — the suite terminates on its own, with under a second between the
last assertion and the process exiting, which is what says no timer or pool is holding a handle.

Ten and not nine because `core-bench` was split out of `core` during that pass, for the reason
`web-bench` already existed: a file that asserts a wall-clock budget cannot share a scheduling
group with 240 others and still be measuring the code. `vitest.config.ts` carries the numbers.

The suite runs with no network access: the replay store is a wall, and a fixture miss throws rather
than falling through to a provider (FEED-08, QA-02).

## Open issues

### WP-09's audit findings — applied, and a correction to what this file said

WP-09's integration round stalled and never applied the adversarial auditors' findings, so this file
listed all 24 as open. **That was wrong, and wrong in a way worth recording.** The findings were
transcribed here from the audit without checking them against the code, and the audit had run
against an earlier state of the tree: the construction agents had already fixed most of the cluster
in migration `0017`. Three independent passes over the code found the same thing. A resume document
that overstates the damage is no more useful than one that hides it — check findings against HEAD
before writing them down.

What was genuinely open, and is now fixed, is below. Two things stand out. The chain anchor was not
an anchor: the columns were writable by the role the server connects as, so a room's own creator
could rewrite the messages and re-point the anchor to match. And the payload guard worked but had
**no test at all**, while its own docstring described the weaker contract to the resolver authors who
read it — so it would have decayed silently.

**Messaging and tenancy — applied.** Migrations `0017_messaging_alerts_integrity.sql` and
`0018_chain_anchor_immutable.sql` carry the database half; `messaging/service.ts`,
`messaging/surveillance.ts`, `http/routes/messages.ts`, `alerts/engine.ts` and `index.ts` the rest.
Every assertion that claims a policy holds now runs as `terminal_app` (`asAppRole`), because the
migration owner is a superuser locally and bypasses RLS — the suite missed most of this cluster for
exactly that reason.

| Where | What it does now |
| --- | --- |
| `0017` §17.b | `rooms_member` admits `created_by = app_user_id()`, so `INSERT INTO rooms … RETURNING` satisfies its own policy and `POST /rooms` stops 500ing wherever RLS applies. |
| `0017` §17.e + `surveillance.ts` | Hits are written through `record_surveillance_hit`, a SECURITY DEFINER *writer* (it cannot read the queue), so the scan records from the sender's transaction without pretending to be compliance. |
| `0017` §17.d | `surveillance_hits` and `message_reviews` are scoped through the message's room (`room_has_firm`), so a firm reads only queues for rooms its own people are in. |
| `0017` §17.c | `room_members`' `WITH CHECK` is `can_seat_room_member`: a steward of the room, or the creator taking the first seat in an empty one. A self-join by row insertion is refused. |
| `0017` §17.g + `0018` | `rooms.last_seq`/`last_hash` anchor the chain. `0018` is what makes them an anchor: `terminal_app` loses UPDATE on those two columns and a trigger refuses a decrease or a re-point at a seq the room already holds — until it landed, the room's own creator could restate the anchor and re-verify a forged room. |
| `0017` §17.f + `service.ts` | `digest_version 2` covers `structured`, `sender_firm_id` and `client_msg_id`; `verifyChain` picks the expression by the row's own version, so rows written under version 1 keep verifying. `trace_id` is deliberately outside the digest — it is transport metadata, not content. |
| `0017` §17.h + `engine.ts` | `saved_search_query` takes the alert owner, so an alert cannot name another user's saved search; `armed_alerts`/`fire_alert`/`alert_fired_on` give the fan-out a read path and a writer without a blanket bypass. |
| `index.ts` | `attachAlertEngine` runs against plant deltas and a calendar tick, and `onNews`/`onFiling` are the entry points the news job takes as `ctx.alerts`. Nothing passes it one yet: the scheduler is startup step 8 and has not landed. |

**News precision (NEWS-02) — applied.** Ambiguity is decided structurally instead of by
enumeration: `NewsDictionary.isAmbiguous` calls **every one-word surface** ambiguous, whatever the
word is, and an ambiguous match with nothing corroborating it is refused rather than discounted.
The 253-word list stays as curation for multi-token phrases and as a record of real collisions —
its incompleteness now costs recall, never precision.

| Where | What it does now |
| --- | --- |
| `refdata/newsDict.ts` | `isAmbiguous` folds the surface and returns `true` for anything of one token; the word list is consulted only for two tokens or more. The hole it closes is not the bare word (already refused) but the *key*: `normName` strips `THE`, `GROUP`, `HOLDINGS`, `INC`, so the two-token prose runs `THE OUTLOOK` and `RADIANT WORLD GROUP` reached one-token keys and took neither the single-token modifier nor the word list. On the recorded feeds that filed two stories under `Outlook Group Corp` at 0.9215. |
| `news/entityLink.ts` | The ×0.90 modifier is applied as the refusal it arithmetically is (`base × 0.90 < 0.90` for every base under 1.00, and *on* the floor for base 1.00 — so as a discount it could never refuse the one surface it exists for). Corroboration is named and closed: a second method naming the issuer, an exchange qualifier on a ticker mark, a corporate legal form on a name (`CORPORATE_FORMS` — `INC`/`PLC`/`LTD`, deliberately not `GROUP`/`HOLDINGS`/`CO`/`COMPANY`, which are ordinary English), or a key of two tokens or more. |
| `news/entityLink.ts` | `matchTickers` no longer sets `singleToken: false` for every mark: an unqualified `(XYZ)` is one ambiguous token like any other and needs corroboration, while `$AAPL`, `(AAPL US)` and `AAPL:US` are self-corroborating and keep the full 1.00. `$ALL` links now and did not before — the mark decides, not the word list. |
| `news/entityLink.ts` | The floor is **decided**, documented in the file header and asserted on both sides: inclusive at 0.900, and evaluated in `real` through `clearsFloor()` so the TypeScript gate, the `INSERT` guard and `functions/NI`'s read-back are one statement. Nothing can *arrive* at 0.900 by discount any more; only a base of 0.90 with no penalty lands there. |
| `test/integration/news/entityLink.test.ts` | Five adversarial cases that fail against the old matcher, on the recorded corpus where possible: the ordinary-word issuer in ordinary prose (`Outlook Group Corp` ×2 recorded stories), the same name corroborated by a form, a ticker or a CIK, the unqualified-vs-qualified ticker pair, and the exactly-0.900 alias beside the 0.873 below it. The minimum-confidence property over every written link still holds. |

Recall cost, measured over the 160 recorded stories against a 58-issuer universe drawn from them:
207 links → 204. The three lost are two wrong (`Outlook Group Corp`, from "clouding the outlook")
and one right (`Carlyle Group`, whose only surface was "Carlyle Co-President" — a hyphen folded to
a space, which `CO` would have had to admit to keep). Every other link is unchanged, confidence for
confidence.

**Payload honesty (DATA-10) — applied.** `assertPayloadMeta` now judges each cell as well as the
payload. The aggregate rule (a payload holding a number while nothing at all was cited) is joined by
a per-cell rule: the walk recognises a `ValueCell` by shape — `{ v, st, … }` with `st` a
`ValueState` — wherever it sits, and refuses one whose `v` is a finite number and whose `provIdx` is
not an integer `>= 0`. `provIdx: -1` stays what FUNCTIONS_TIER1 §0.4 rule 1 reserves it for: a
pending or denied cell, whose `v` is null. Both rules follow `strictVariant` — throw in dev and
test, warn in production — and `test/unit/functions/runner.test.ts` pins the per-cell rule in both
directions, including the case the aggregate rule cannot judge (a payload that cites *something*).

| Where | What it does now |
| --- | --- |
| `functions/runner.ts` | Per-cell rule beside the aggregate one, so one citation no longer excuses every other number in the payload. |
| `functions/Q/resolve.ts` | The line's citation is computed before `lineCells()` and passed in; `-1` survives only on the pending and denied branches. |
| `functions/GIP/resolve.ts` | `vwapProvIdx` carries the bar block's idx beside the `vwap` series (`-1` only when there is no series). |
| `functions/GP/resolve.ts` | `reference[]` carries `provIdx`: the strike cites `option_terms`, the last yield its own series, the prev close the plant cell that already held one. |
| `core/fields/defs/analytic.ts` | `RET_*` and `VOL_*` say what the code computes — simple returns on the split-adjusted (`price`) close series — and the file header records the direction the conflict was reconciled in and why. |

A bare series (`number[]`) is out of reach of a shape walk and is cited at block level instead
(`GpSeries.provIdx`, `GipPayload.vwapProvIdx`); that is a convention a reviewer checks, not something
the guard proves.

**Goldens.** The Tier 1 goldens are hand-seeded rather than derived from the recorded captures, and
three hand-typed values contradict their capture outright. `HP.series`, `HELP.default` and
`SECF.default` have no committed golden at all. `HP.price.json` asserts a session on Labor Day 2020,
a day its own declared calendar says the exchange was shut.

### The golden comparisons were non-deterministic, and are not any more

Every golden payload test normalises database ids to stable tokens before diffing against the
committed file. The substitution used to be **value-based**: any number equal to a sequence-allocated
id was rewritten, whether or not it was an id. So the tests passed by luck of the draw, and the
collision space grew every run.

These were not hypothetical. Reproduced against the committed goldens: an instrument id colliding
with a 52-week high (`WEI`), a market-data line id with a bid size (`Q`, four fields), an instrument
id with a closing price (`HP`, **167 fields** — the whole price history, which would read as a
catastrophic resolver regression). Worst is `ECO`: `eco_events.event_id` is a fresh sequence whose
first values are literally 1, 2, 3, and every event carries an `importance` of 1, 2 or 3 — that
collision is one `TRUNCATE … RESTART IDENTITY` away, not a long run away.

Substitution is now **key-aware** across all 25 files: a number is rewritten because of the key it
sits under, never because of what it equals. `golden.ts` gained `idToken(key, value, idKeys, tokens)`
as the number-valued twin of the existing `subjectToken`. Proven equivalent rather than merely
different: hash all 49 goldens, regenerate through the new rule, re-hash, diff empty.

Two things worth keeping in mind. `HDS` and `PORT` carried a hand-written exception for one field
(`key !== 'provIdx'`) — that carve-out was the defect admitting itself, someone had been bitten and
patched the symptom. And one textual substitution survives deliberately, in `MSG`, because that
payload quotes ids inside free text (`"W 41"`, `"portfolio #7"`) where a key rule cannot reach; it is
the documented exception, not an oversight.

### Two rate conventions were decided in WP-11, not defaulted into

Both are live choices someone may want to revisit, so they are recorded rather than buried in a
diff. Numbers for the alternatives are in the WP-11 commit message.

- **Key-rate bumps are applied in log-discount space**, so one basis point is the same perturbation
  whatever basis a curve quotes its zeros on. `UST_PAR` stores semiannual and `SOFR_OIS` stores
  simple, and a "1 bp zero bump" on a simple-compounded curve at 30y is about four times smaller a
  move — bumping each curve on its own basis would tighten three of four bonds but make `KRD_30Y`
  mean different things on `YAS` and `SWPM`, which is the defect that fix existed to close.
- **`YAS` uses a central ±1 bp bump, `SWPM` a one-sided one.** Same operator, same kernel, same
  shared module, different estimator of the same derivative. `SWPM`'s header records the one-sided
  choice and its goldens are pinned to it; aligning them is a two-line change plus a golden.

Related and still true: the two screens' key-rate durations are sensitivities to **different
curves** (`UST_PAR`, `SOFR_OIS`). They now measure the same quantity the same way, so they compose
as hedge ratios, but they were never additive and still are not.

### Two WP-12 findings left open, both deliberate

- **`na` and `stale` share the `·` glyph.** One mark, two meanings in one grid. The fix the audit
  wanted is in `theme/tokens.css`, which WORKPLAN L1340 puts outside WP-12, and `CLIENT.md` §12.1
  specifies `·` for both as explicitly as it specifies anything. Changing either needs the design
  document changed first, so it is a decision rather than a patch.
- **The chart cites one provenance index per canvas.** A multi-series chart now cites an index only
  when every series agrees on one, and cites nothing otherwise, which is honest but coarse. The
  per-series answer arrives with WP-14's `ChartCanvas`, and the props contract records that it must
  set the index per focused series.

Also closed here, found in passing rather than by either audit: `no-restricted-globals` matches a
BARE identifier only, so `window.fetch()`, `globalThis.fetch()` and `new self.WebSocket()` linted
clean in `packages/web/src` — the browser IO boundary written as a rule people are told to trust,
with a hole in it. There was no breach to find; a `no-restricted-syntax` companion now closes the
qualified forms (proved with a throwaway probe: three violations caught).

### Nothing rendered `LiveGrid`, and no work package owned the wiring — CLOSED in tier 1

**Closed in `8934dfd`:** panels subscribe their manifest `LiveSpec`, the 1 s staleness sweep reaches
cells, and `live-grid.spec.ts` asserts a `sub` for every row the grid drew. The chain below is the
account of what was broken, kept because the second half of it is the reason the default desk's chart
panel was not simply retargeted at a security with history — see that entry further down.

WP-13 builds the grid, and the grid is reachable from no screen in the running app. The chain is
`App.tsx` → `Shell` → `PanelGrid` → `Panel` → `ScreenRenderer` → `screen/widgets/Grid.tsx` →
`registry.LiveGrid`, and it is broken in two places:

- `App.tsx` still renders `ShellPlaceholder`, not the real `<Shell/>`. Its own comment says so. That
  makes WP-12's shell unreachable too, so this is not something WP-13 introduced.
- Nothing anywhere in `packages/web/src` ever constructs a `WidgetRegistry`. `ScreenRenderer`
  defaults `widgets = {}`, `Grid.tsx` reads `registry.LiveGrid`, finds `undefined`, and draws the
  `data-pending="LiveGrid"` placeholder on every `grid` node of all 38 screens.

An empty registry was the correct WP-12 state — `registry.ts` says so explicitly, and the
placeholder names what it is waiting for rather than impersonating a grid. WP-13 is the package that
should have filled it, and could not: `WORKPLAN.md` L1723 assigns `src/App.tsx` to WP-01 and L1725
gives WP-13 only `grid/**` and `rt/**`, so the two construction sites are both outside it. No later
package claims the handoff either — WP-14 adds `ChartCanvas` to the same unbuilt registry, and
WP-15's integration checkpoints I9 and I10 *assume* it exists.

**This needs assigning before the app can be run at all**, and it is one file: whoever mounts the
real `Shell` builds `{ LiveGrid, ChartCanvas, custom }` and passes it down. The components on both
ends are finished and tested against each other's contracts; only the constructor is missing.

### `widgets/Grid.tsx` passes 14 of `LiveGridProps`' 21 members, and that is correct

The audit read the omission as a defect. It is not: `rowHeight`, `liveSortThrottleMs`,
`onSortChange`, `onGroupChange`, `onColumnsChange`, `onSelectionChange` and `onFocusCell` are all
optional in CLIENT.md §10.2 with stated defaults, and the `ScreenSpec` `grid` node
(`screen/types.ts` L81-95) carries no field for any of them — so the renderer has nothing to pass
and spreading `undefined` under `exactOptionalPropertyTypes` would say less than absence does.
`onFocusCell` is not on the `Ctrl+I` path either; provenance is answered by reading `data-prov-idx`
off the focused element, which `LiveGrid` writes per cell. Persisting a user's sort or column order
across a screen redraw is a `ScreenSpec` feature nobody has specified, not a missing prop.

### Both WP-13 blockers were states that reached no reader

Worth keeping, because neither was a crash and both passed their own tests:

- **The gap grey was invisible.** On a detected sequence gap `wsBridge` greys the screen by calling
  `setSubjectStatus(subject, 'stale')`, but the registry mapped only `shed`→stale and `gone`→blank,
  so every other status wrote nothing. Between a gap and its healing snap, every cell still rendered
  `data-st='live'`, the live colour, the live glyph and the accessible name "…, live" — about numbers
  the client had just refused to update. The one failure this protocol cannot repair silently was
  the one it did not show. The registry now mirrors `QuoteCache`'s own split, and the grey is
  reversible: a resync snap that restates identical prices reports no changed fields, so a grey that
  only new values could lift would have stayed for the session.
- **The flash leaked a listener per tick.** `trigger()` attached an `animationend` listener with
  `{once: true}`, which self-removes only when it *fires* — and every early-clear path removes the
  class, which cancels the animation, so it never fires. Measured: 300 deltas on one cell left 300
  listeners and 0 removals. Because `addEventListener` scans for duplicates, the tick path was
  quadratic in ticks per cell. One permanent listener per element replaces it, and drift over three
  rounds went from 2.53× to 1.0×.

The second one is the third time in this build an acceptance test was shaped so it could not fail:
`frame-budget.bench.ts` asserted only round 1's p95, and round 1 is the fast round — round 3 was at
8.3 ms against an 8 ms budget while the file passed. It now asserts every round. The budget itself
was not touched.

### The application could not start, and nothing could see it

`src/index.ts` exits 1 rather than serve behind a pending migration (ARCHITECTURE §12.1 step 2), and
`db/client.ts#pendingMigrations()` counted rows in drizzle's `drizzle.__drizzle_migrations` — a table
`scripts/migrate.ts` never creates. The migrator applies each file itself and records
`schema_meta('migration:<filename>')`. So on a database migrated by the only mechanism this
repository has, the check reported all nineteen files pending and **the server refused to boot**.

Latent since WP-01 and invisible for fourteen packages, because every integration test opens a pool
directly through `withTxDb` and never calls it: 254 green test files could not see it. WP-15's
Playwright specs are the first thing that boots the real process. The comparison is now by NAME
against `schema_meta`, which is also strictly stronger — the positional `files.slice(applied)` read
"nothing pending" for a migration applied out of order or deleted from the middle of the ledger.

Verified by booting the real process: `GET /api/v1/health` → 200, `migrationsPending: 0`, `db: true`,
`plant: true`.

### Five startup steps said "a later work package's" — four are wired, step 8 is deferred on purpose

Booting it also showed what had not been wired. `src/index.ts` skipped, by number:

| Step | What was skipped | State |
| --- | --- | --- |
| 3 | the field dictionary and its field-id validation | wired, `startup.ts#validateFieldLicences` — fatal on a bad row |
| 4 | calendars and the function-registry consistency check | wired, `startup.ts#loadCalendars` / `#checkFunctionRegistry` |
| 5 | the universe search snapshot and its ETag | wired, awaited before the listener, on `AppDeps.universe` |
| 8 | the ingest leader lock and the scheduler | **deferred**, for three measured reasons — see below |
| 9 | the usage-event and DQ writers, and the 1 s staleness sweep | wired: both buffered writers started after the listener, the sweep armed by `ws/gateway.ts` since WP-06 |

Three of the four wired steps had been skipped behind a log line **no test could see**, because
`index.ts` executes on import and nothing in a test can call it. That is why the checks live in
`packages/server/src/startup.ts` as functions over an injected handle, and why
`test/integration/startup.test.ts` can run the steps the shipped process runs — including the two
failure paths, and including a block that spawns the real entry point and reads `/health` off it.

Step 8 is the one still deferred, and no longer for lack of code: the lock, the scheduler and all 26
jobs are merged and compose. `startup.ts#DEFERRED_STARTUP_STEPS` carries the three reasons, each of
which reaches outside that file — a replayed poll re-inserts the provenance rows the seed already
wrote (12 per tick), the plant may not join a `JobContext` until the two writers of `quote_ticks` are
reconciled (see below), and `JobContext` carries no `HttpClient` for a live deployment to use.

So `/health` still answers `status: "degraded"` with `scheduler: false`, and that is the truth rather
than a gap in the report — the field that says *which* truth is `scheduler`, not the verdict. Booted
cold against a database of its own at the close of the backlog:
`{"status":"degraded","db":true,"plant":true,"scheduler":false,"migrationsPending":0,"uptimeS":13}`,
HTTP 200, with one warning on the whole startup log (step 8) and a clean `exit 0` two seconds after
SIGTERM.

### The seed and the test suite wanted opposite databases

`globalSetup` has always called `runSeed()` (TESTING §4.2 step 5). That was harmless for thirteen
packages because only `seed/licences.ts` existed and the runner skips what it cannot find — so the
step wrote 33 licence rows. WP-15 wrote the other twelve modules and it began writing the real
universe into `bloomberg_test`: 41,455 instruments, 36,188 md lines, 160 news items.

Two legitimate contracts then collided. `volumes.test.ts` can only assert §18's row counts against a
database that has them; ~145 ingest and function tests written across WP-05…WP-11 assert what their
own job inserted into an empty table. Against a seeded one the job correctly inserts nothing, which
is idempotency working — and `ingest/marketDataJobs.test.ts` failed all 8 tests with SQLSTATE 23P01,
because it writes an `md_lines` version valid from 2020 while the seed holds one from 2026 and
`md_lines_symbol_excl` refuses two open-ended ranges for one key. Not a count to adjust.

Resolved by separating the databases, not by rewriting the tests: the seed is gated on
`SEED_TEST_DB` and runs for one project, `server-seed`, which owns `bloomberg_seed_test`. Module 1
still runs everywhere, because `assert_source_known` gates every write in the schema — found by
breaking it. `globalSetup` also now reads `DATABASE_URL_TEST`/`DATABASE_URL` from the **calling
project** rather than the ambient environment: it runs in the vitest main process, where a project's
`test.env` does not apply, so it had been migrating one database while the tests read another. Both
deviations are recorded in that file's header and in the `server-seed` comment in `vitest.config.ts`.

### `DES` told the user there were no facts for a CIK whose facts were in the table

The seed wrote zero `fin_statements` rows with `period_type = 'TTM'`, though the module header and
§18 both claim Q/FY/TTM and the CHECK constraint permits it: `secCompanyFacts.ts#periodTypeOf` could
only ever return `'Q'` or `'FY'`. Three screens depend on TTM — `DES` requests it, `RV` defaults to
it, `EQS` reads the newest TTM row per issuer — so on the flagship seeded security `DES` blanked four
fields and emitted `unavailable { reason: 'NO_SOURCE', detail: 'no XBRL facts ingested for CIK
0000320193' }`. 25,116 facts for that exact CIK were in the table. A wrong reason code is worse than
a blank cell, and `AAPL US Equity DES <GO>` is the first thing WP-15's e2e specs drive.

Fixed at the cause — a TTM roll-up beside the existing Q4 derivation, 260 rows, flows summed over
four quarters only when all four report, instants carried from the anchor, share counts excluded
because four weighted averages do not add, and provenance citing all four source quarters. Nothing
had asserted `fin_statements` at all, which is why it shipped; `volumes.test.ts` now asserts it
grouped by `period_type`, because a total would have hidden a missing third and did.

### `db:seed` was not idempotent, and its test could not see it

Every re-run inserted 20 `provenance` rows and 9 `ingest_runs` rows and rewrote all four
`quote_snapshots` state blobs to cite the new ids — measured 56 → 76 → 96 over three runs. In
`PROVIDER_MODE=replay` no exchange happened, so ten runs would leave 200 rows asserting 200 provider
round-trips that never occurred, in the table DATA-10 exists to make trustworthy.

`idempotent.test.ts` could not observe it because it ran five of the nine modules — omitting exactly
the two that still had the bug its own header said it was written to catch. It now runs all nine,
pinned against `SEED_ORDER` so a tenth cannot escape, and compares an md5 digest of every table with
wall-clock columns excluded by their DEFAULT rather than by a name list — which is the instrument
that catches a row rewritten in place, as no count can.

Two more findings came out of making it idempotent, both tests that could not fail: `bars.test.ts`
compared the two snapshot states with `provenanceId` **masked out**, hiding precisely the rows the
seed rewrote on every run; and its `eod_snapshots` flag assertion passed only because its own setup
re-ran the Cboe legs and rewrote the rows — it was checking its own artefact, not the seed's. Once
the legs became idempotent it read the seeded rows and disagreed, correctly: BUK100P publishes a real
close (1059.4557), so nothing stood in for it.

### Provenance pointed at the seeding developer's home directory

`seedFileProvenance` stored `file:///Users/<name>/Desktop/bloomberg/fixtures/seed/treasuries.json`
as `request_url`. That breaks the determinism WP-15 claims — two checkouts at different paths produce
different provenance bytes for the same fixture — and `request_url` is what the `Ctrl+I` popover
shows, so every seeded Treasury attributed itself to a path containing a person's home directory. Now
`seed://treasuries.json`, matching the convention the universe module already used, and the `file:`
branch of the classifier was **removed** rather than left as dead tolerance, so a module that reaches
for `pathToFileURL` again fails the DATA-10 walk instead of passing quietly.

### What part 2 demonstrated, and the defects it recorded

`npm test` excludes `packages/e2e` from vitest entirely, so a green vitest suite is still not a
demonstrated UI — `npm run test:e2e` is the separate ask. It now passes: **39 tests, run twice with
identical results, 30 green and 9 expected failures, 3.3 min a run** (Google Chrome, plant and app
on their own slot, `bloomberg_e2e_17` copied from `bloomberg_seed_test` in ~1 s by
`packages/e2e/fixtures/database.ts`). `smoke.spec.ts` was rewritten against the real shell —
`Command line p1`, no `panel-frame` — and every spec asserts SEEDED values: `330.27` with its
`data-prov-idx`, `CIK 0000320193`, `7,585.75`, `31 rows` of WEI, a CSV compared cell for cell with
the grid on screen. Drop the seed and the suite fails on its first universe assertion.

Four product defects were found while writing them and fixed in `packages/web` (all four invisible
to 254 green vitest files, because each needed the composed app in a real browser): a live cell whose
snapshot restated its payload value was painted EMPTY, because `CellRegistry.register` routed a first
paint through `#write`'s no-op skip; `html, body, #root` had no height, so the whole terminal was a
337 px band and every panel a 156 px sliver; `.chart-host` / `.custom-host` had no height rule, so a
year of Apple drew into a canvas 1 px tall; and `Panel.tsx` handed screens `frame.params` raw, so a
restored WEI frame — which stores only the keys the user set — blanked the page on
`params.regions is not iterable` (regression test added in `web/test/shell/panels.test.tsx`).

The nine expected failures were `test.fail()`, never `test.skip()`: each one RUNS on every suite, its
assertion is the one the product should satisfy and is not weakened by a millisecond, and the day it
is fixed Playwright reports "expected to fail but passed" so neither the fix nor the record can rot.

**That mechanism did its job: eight of the nine are now required assertions and one remains.** The
backlog closed seven in tier 1 (`8934dfd`) and the chart panel in tier 2, each time by fixing the
product and flipping the `test.fail` in the same change — which is why the flip is not optional
bookkeeping: Playwright turns the suite red on a `test.fail` that passes, so a fix cannot land and
leave the record stale. Counted at the close of the backlog, `grep -n 'test\.fail('` over
`packages/e2e/tests/` returns exactly one line, `autocomplete.spec.ts:455`, and a full run reports
`44 passed` with no "expected to fail but passed" anywhere. The **Status** column below is the
record, kept rather than deleted because what each one measured is the argument for the assertion
that replaced it.

| Spec | Status | What it records |
| --- | --- | --- |
| `smoke.spec.ts:632` | fixed, tier 1 | **DEFECT** `App.tsx#onRestored` (L1135) re-runs a restored frame as `"<security> <fn>"`; the dispatcher resolves that display as a REF, so the adapter at L664 pushes a frame with `security: null` — which is then persisted. The SECOND load of the terminal restores GP with no instrument (TERM-05). |
| `panels.spec.ts:371` | fixed, tier 1 | **DEFECT** the same line drops the frame's `params`, so a panel saved as `W Core` (5 rows) comes back on the manifest defaults (`W · S&P 500 Top 25`, 25 rows) (TERM-05). |
| `help.spec.ts:345` | fixed, tier 1 | **DEFECT** `Shell.tsx` L113-123 restores the workspace in an effect keyed on `onRestored`, whose identity changes whenever the HELP overlay opens (`onHelp` → `dispatchDeps` → `onRestored`). Opening HELP therefore re-restores the workspace, and the ticket captures a screen the user never asked about (TERM-09, and a TERM-05 defect in its own right). |
| `help.spec.ts:398` | fixed, tier 1 | **GAP** `App.tsx#PanelOverlay` closes the dialog from `onOpened`, so `TicketDialog`'s "Ticket N opened / MSG room M" confirmation never paints. The ticket IS created (`201 {ticketId, roomId}`) and the user is told nothing (TERM-09). |
| `live-grid.spec.ts:454` | fixed, tier 1 | **DEFECT** `cellRegistry.ts#restyle` returns on its first line because `setStateSource()` is never called by any product file, so the client's 1 s staleness sweep never reaches a cell — the client-side twin of the server's skipped startup step 9. A dead feed leaves a `live` number on screen (TERM-12). |
| `entitlement.spec.ts:367` | fixed, tier 1 | **DEFECT** a value withheld by the eod grant arrives as `st: 'closed', r: 'TIER_EOD'`, not `blank`, and `CellView` prints `.cell__reason` only for `blank` — so a withheld price and a missing price are the same em dash, which is the thing the rule exists to prevent (ENTL-05). |
| `export.spec.ts:472` | fixed, tier 1 | **GAP** nothing in the UI invokes `ScreenCtx.export()` and the window keyboard dispatcher that would bind `Ctrl+P` is not attached (`App.tsx` L56-69). The export path is proven cell-for-cell by the test above it; the gesture is missing (FUNC-03). |
| `autocomplete.spec.ts:454` | **OPEN** | **FINDING** `timings.autocompleteP95Ms` is a hard-coded `0` (`routes/status.ts` L460) and `perf/marks.ts` does not exist, so the channel WP-15's acceptance row names carries nothing. The budget is measured by the spec instead: p95 5.3 ms keystroke → rows, 15.7 ms keystroke → painted frame, over 84 measured keystrokes. |
| `smoke.spec.ts:508` | fixed, tier 2 | **SEED GAP + SUBSCRIPTION GAP** `bars_daily` has no SPX row, so `GP · SPX Index` — the first chart every seeded user sees — draws an empty canvas; and retargeting that panel at a security with history blanks a correct cell two panels away. Both halves measured below. The chart itself is proved green on AAPL (243 bars, `High 340.08`) by the test above it. |

### The default desk's chart panel plots nothing, and the obvious fix makes it worse — CLOSED

**Both halves are closed and the account below is history, kept because it is the argument for how
they were closed.** Neither was closed the way this section proposed. The subscription half went
first, in tier 1, by giving every panel its manifest `LiveSpec` so the union of fields is what the
server is told — after which the retarget this section called for was *safe* and was still not taken,
because the seeded panel is named by four other specs and an index is what the default desk's chart
is for. The seed half was closed in tier 2 by the range instead of the instrument: the capture that
holds SPX is `yahoo-chart-SPX-5d-5m.json`, GP reaches intraday bars at `1D` and `5D`, and `5D`
answers 200 with 376 bars where `1Y` answers 200 with zero — so `fixtures/seed/workspaces.json`
asks for `5D` and `GP · SPX Index` keeps its instrument and draws. `smoke.spec.ts:583` is a required
assertion over the canvas's own ink, and its header carries the measurement, including why
`data-chart-state` reads `drawn` for an empty canvas and is therefore not what it asserts.

Two halves, and the second cost a suite run to learn, so it is written down properly.

**The data.** `bars_daily` holds AAPL with 1,255 closes and nine FX pairs with one row each. SPX has
none, so `GP · SPX Index` — p3 of every seeded workspace — returns `primary.t[]`/`primary.c[]` empty
and the panel says so honestly (`no bars in window`, `Bars 0`, legend `S&P 500 —`). No capture can
fix it: `yahoo-chart-SPX-5d-5m.json` is five-minute intraday and the seed may not invent history.
Note also that the two assertions which named that panel were satisfied by the quote row *beside* the
empty canvas, so deleting every bar in the universe would not have turned either red — a third
instance of a test that cannot fail, now replaced by an assertion on `.chart-host[data-chart-state]`.

**Why it was not simply pointed at AAPL.** Tried, measured, reverted. Retargeting p3 draws the chart
and **blanks a correct number two panels away.** `ChartCanvas` is the only thing in the application
that subscribes anything — `state/subscriptions.ts#acquire` has no product caller, so no grid subject
is ever subscribed — and it subscribes `fields: ['PX_LAST']`. A `sub` makes the server REPLACE its
field mask and answer with a fresh `snap`, so the moment the chart subscribes `q:85` the cache holds
an AAPL view with no `CHG_PCT_1D`, and `W · Core`'s Apple row — correct at `-0.84%` from its payload —
renders `— unavailable`. Two specs caught it: `smoke.spec.ts`'s seeded-values test, and
`live-grid.spec.ts`'s TERM-08 flash, whose injected snapshot stopped reaching a cell no longer masked
for it. The SDK is not at fault: `SubscriptionManager#desiredFields` unions correctly across holders,
and its comment already explains why a narrowing is never re-sent. There is simply only one holder.

So the order of work is: wire grid subscriptions so the union of fields is what the server is told,
**then** retarget the panel. The other way round trades an empty canvas for a wrong cell, and a wrong
cell is worse. Both halves are recorded in `smoke.spec.ts`'s own header beside the `test.fail`.

### One performance finding was raised and then refuted

Worth recording so nobody re-opens it. The auditor read `timings.fnLaunchP95Ms` and reported WEI over
the 500 ms first-paint budget at p95 589 ms. That column is `go → payload`, not `go → first paint`,
and measured directly in the browser over four runs of six launches WEI came out p95 439–465 ms —
inside budget every time. The plant's figure is a different quantity, not a larger version of the
same one. `command-line.spec.ts` now measures the budgeted quantity and asserts it.

### Four more found while driving the terminal, none in WP-15's own code

- **Two panels of the default workspace draw on top of themselves.** WEI's three regional grids clip
  each row to about one line, so rows collide with the next region's header, and `W · Core` paints
  its watchlist-picker pane through the Security/Name/Last columns. Confirmed pre-existing by
  screenshotting with part 2's CSS reverted: a WP-12 split/virtualiser layout defect nothing had
  looked at, because until part 1 no test had ever rendered the shell at window size.
- **WEI refuses to render when its quotes are absent, and calls it `ARG_PARSE`.** Deleting the seeded
  `md_lines` for AAPL/SPX/VIX/BUK100P makes the panel print `ARG_PARSE: WEI: numbers with no
  provenance and no engine: historySessions (DATA-10)`. The guard firing is correct — the screen
  refuses to print an uncited number — but nothing was parsed, so the code sends the next reader to
  the wrong file.
- **The quota strip never refreshes.** `state/session.ts` exports `setQuotas` and nothing calls it,
  so the strip is seeded once at page load and frozen for the session although `GET /usage/quota`
  answers. This is why the counter test reloads the page instead of watching the strip move.
- **`packages/e2e/tests/perf.spec.ts` does not exist**, though TESTING §17 names it as the measurer
  for the keystroke and launch budgets. Both budgets ARE measured — the keystroke one in
  `autocomplete.spec.ts`, the launch one in `command-line.spec.ts`, which is where CLIENT §16.1 puts
  it. The document and the tree need reconciling, not a third file.

Two composition-root gaps are recorded in the specs' own headers rather than here, because neither
has a spec that can fail on it: no grid subject is ever subscribed (`state/subscriptions.ts#acquire`
has no product caller, so the only `sub` frame the app sends is `ChartCanvas`'s and `subs 0/10,000`
is literally true), and the five deferred startup steps still make `/health` report `degraded`.

Also open, each recorded where it can be acted on: the window keyboard dispatcher is built but never
attached, so five documented keys are dead and TERM-06/TERM-07 are now `partial`; `Composer` (MSG,
FXC) and `Sparkline` (DES, ECO, EE) have no registered component; `secFrames.ts#comparableName`
raises 834 false `reconcile_mismatch` events because it replaces punctuation before removing
corporate suffixes, so `L.P.` becomes two tokens its own pattern no longer matches; nine
`provenance` rows are intra-run duplicates, because a module cites a capture to hang an md line on
and the ingest job that reads it inserts its own row; and `fn-parity.test.ts` carries four
green-with-known-defect census tables naming five resolvers that answer 500 on the seeded universe
and twenty exports refused 403 for a field with no `field_licence` row.

### `chart/scales.ts` was 761 lines that nothing drew with — CLOSED, the other way round

**Resolved in tier 2, and not by the import this section asked for.** The copy that draws won:
`scales.ts` is now 155 lines holding the two MAPPINGS the rest of the package places things by —
value → position and slot → position — and the duplicated tick and label maths is gone from it.
`layers.ts` owns tick *choice* as well as tick *values*, including CLIENT §11.2's zoom-dependent
thinning, and its header records what was deliberately **not** adopted from the module that died: a
2.5 rung on the step ladder, and the upward half of §11.2's y-tick rule (an 800 px pane deserving
eleven gridlines rather than five). Both would move every committed hash in
`fixtures/golden/chart/series-hashes.json`, which is a decision to take on its own and not inside a
deduplication. What *was* taken is `targetYTickCount`, a ceiling that only ever removes a label drawn
on top of another one: reverting it puts five y labels into a 20 px study pane, which is now an
assertion, because no golden or spec had ever rendered a chart with three `sub` study panes.

The account below is why that direction was chosen, and is kept for it.

WP-14 shipped three implementations of the same geometry and wired the wrong one. `scales.ts` —
`yAxisScale`, `linearScale`, `logScale`, `tenorScale`, `slotScale`, `categoryScale`, `niceStep`,
`timeTicks` — is imported by **no source file**; `grep -rn "from './scales"` over
`packages/web/src/` returns nothing, and the only mentions in `renderer.ts` are three comments.
`renderer.ts` carries a private axis builder (`buildAxes`, `padded`, `scalesFor`, `normaliserFor`)
and `layers.ts` a third copy of the tick and label maths.

So `scales.test.ts`'s 29 assertions are green about code the product never executes, and both of the
axis blockers the audit found — a sub-pane domain computed over the whole series rather than the
viewport, and a `valueAt` that did not invert the normaliser — were in the copy that actually draws.
`scales.ts` had neither: its `YAxisScale` already exposes `invert(px)` and already takes the
viewport. The module written for the job was correct and unplugged, and the duplicate rebuilt under
deadline was not.

Both repair agents verified this and neither could fix it: the one-line repair is an import in
`renderer.ts`, and the split gave that file to the other. `fix:numeric` predicted it would fall
through the gap and asked for it to be assigned, which is what this entry does.

**Not fixed here deliberately.** Wiring `yAxisScale` into the renderer means extending it for the
study axes (`<paneId>:y` has no `ChartSpec.yAxes` entry), the reference lines and the per-axis
normaliser, then re-pointing a 2,000-line file that was rewritten hours earlier — a refactor of the
two largest files in the package, at commit time, against 5,500 tests, to remove duplication rather
than to fix a defect. That is a change worth making deliberately and on its own. Until then no
module here should be believed because its own test is green.

### `GET /status` published a p95 of neither quantity — a regression tier 2 caused

Worth recording because the round that caused it is the round that found it, and because it was
invisible by construction until then.

`routes/status.ts` computes `timings.fnLaunchP95Ms` as `percentile_cont(0.95)` over
`usage_events.duration_ms` for `kind = 'fn.launch'`. FUNCTIONS.md §588 makes the server runner the
AUTHORITATIVE writer of that event, and the web client posts a second row for the same launch
carrying a different quantity — GO → first paint — which API.md L785 keeps rather than refuses and
flags `details.clientReported`. So a launch from the shell produces two rows measuring two things,
and the query pooled them.

For fifteen packages that was harmless, because startup step 8/9 were deferred and the authoritative
writer therefore wrote nothing: every `fn.launch` row in a running deployment was the client's, and
pooling all of them happened to be right. **Wiring step 9 in tier 2 is what made it wrong**, and it
surfaced as a figure that moved without the server changing — `W` read 215.0 ms on a quiet machine
and 739.2 ms in a loaded run, and the e2e assertion over it was inside budget by luck rather than by
margin. `/usage/functions` already excludes the client's rows and `routes/usage.ts` records exactly
this reasoning; the status route did not.

The query now excludes them, so the published figure is the runner's own duration — which is what
`GET /status` is for, and what `command-line.spec.ts`'s OPS-03 case prints as "go → payload". The
client's go-to-first-paint is the quantity REQUIREMENTS L306 budgets, and the browser asserts it
directly over twenty warm launches rather than through a self-reported figure. The integration test
now writes a 9,000 ms `clientReported` row beside a 42 ms server row and asserts the p95 is 42;
removing the predicate reports **8552.1** instead, so the test cannot pass against the pooled form.

### A gap in a series kills four studies and used to kill the chart

`ChartSeries.y` documents `NaN` as a gap, and §11.2 makes one ordinary as soon as a second calendar
is on the chart. Measured on one 120-bar series with a single hole, before repair: **`EMA`,
`KELTNER`, `PSAR` and `MACD` produced not one finite value after it** — the recurrence ran straight
through the `NaN` and every later slot inherited it — and **`BB` and `STDDEV` threw a `RangeError`**
out of `core/analytics/stats`, which validates its input and is right to.

The throw was the serious half. It arrives inside `setSpec`, so one gapped series plus one Bollinger
in a persisted study list was a dead screen — the same failure the audit's first blocker described
for a missing column, through a different door. Three things changed:

- `Renderer.computeStudies` now guards the `compute` call and records the failure on
  `skippedStudies()`. A study is third-party code as far as the renderer is concerned, so one of
  them failing costs its own pane and nothing else.
- `emaSeries` re-seeds per run of finite values, the rule `wilderAverage` already states in
  `oscillators.ts`. That restores `EMA` and, with it, `KELTNER`'s mid.
- `KELTNER` stopped keeping a private Wilder ATR and calls the `trueRange` and `wilderAverage` that
  `oscillators.ts` exports — its doc says it exports them for exactly this. The two studies now
  cannot disagree about the same volatility on the same screen, which they did: after a gap the
  `ATR` pane re-seeded and carried on while Keltner's band silently vanished for the rest of the
  chart. The `KELTNER` golden is unchanged, because the daily capture has no gap.

**Closed in tier 2**, each the same shape of fix as `emaSeries` and each in its own study, under one
rule stated in all four: **a gap ends a run, it does not end the series.** `MACD`'s two EMAs are now
seeded and followed per maximal run of finite values rather than once from the first finite point —
`prev += alpha * (NaN - prev)` is `NaN`, so a hole anywhere after the seed had been emptying both
lines and the histogram with them. `PSAR` splits the column into runs the same way and deliberately
does **not** carry trend direction, extreme point or acceleration across a gap, because the stop it
prints has to be a stop somebody could have placed; before the fix `Math.min(NaN, …)` kept the `NaN`
and one absent bar removed the stop for the rest of the chart. `BB` and `STDDEV` return a gapped
column instead of throwing: the three lines stay `NaN` for exactly the `n` slots whose window spans
the hole, which is what "a study that cannot answer" should look like, and the guard on
`computeStudies` is now a second line of defence rather than the only one. `windowMax`/`windowMin`
got the same treatment, since `NaN > best` and `NaN < best` are both false and a hole was being
skipped rather than propagated.

### The million-point cold frame is faster and still not inside §16.1

`DownsampleCache`'s scans called `TradingDayIndex#indexAt` once per point — a `Map.get` and a bounds
check for each of a million — where the index already exposes `indexBySlot`, the `Int32Array` behind
it. Hoisting it out of the three loops took a million-point M4 from **23.1 ms to 18.1 ms median**
(measured in situ, identical column count), against the ≈8 ms/million that §11.1's "~40 ms for five
million" implies. The remaining cost is in the reduction itself, not the lookup. The 16 ms budget is
asserted on the draw and was not relaxed; the cold figure is printed by `chart.bench.ts` with its
own numbers.

That hoist broke `chart.bench.ts`'s cache test, and the way it broke is worth keeping: the test
counted `indexAt` calls as a proxy for slots visited, so removing the per-point call zeroed the
instrument while every property it guarded still held. It now reads `slotsScanned()`, a tally the
reduction owns, incremented from the scan bounds so it costs nothing on the hot path. Mutation-
checked: making `invalidateLastColumn` rescan the whole range gives `expected 5019 to be less than
25.1`.

### The three web benches run in their own serial project

`chart.bench.ts`, `grid/frame-budget.bench.ts` and `shell/autocomplete.bench.ts` assert wall-clock
budgets, and running them beside ~240 other files made them measure the runner. CHRT-02's ten-year
pan and zoom is 3.0–4.4 ms p95 with the machine to itself and was 9.7–19.8 ms against a 16 ms budget
in the parallel suite, failing two rounds in five on scheduling alone — while `frame-budget.bench.ts`
beside it drives frames to 84–103 ms, so the benches were each other's noise. They now run in
`web-bench`, one worker, after every other project, for the same reason `server-serial` and
`server-replay` exist. **No threshold changed.** Contention only ever inflates a p95, so this makes a
real regression visible rather than permitting a slow one.

**Tier 2 found the other half of the same problem, and it was larger.** `core`, `sdk`, `server-unit`
and `web` all default to `groupOrder` 0, so Vitest 5 runs them as ONE scheduling group — and with
`maxWorkers` unset each sized its own pool at `availableParallelism() - 1`, i.e. up to 28 workers on
8 cores. The group was starving its own members, and what it starved first was every suite that times
something: `web/test/command/localIndex.test.ts` read 386–499 ms against CLIENT §16.1's 300 ms worker
build (246 ms when it has a core), `server/test/unit/providers/parse.fuzz.test.ts` timed out against
10 s (a 4.7 s test unstarved), and `core/test/formula/formula.fuzz.test.ts` timed out against 5 s.
The loudest single cause was `core/test/command/command.bench.ts`, which builds a 45 000-entry index
and ranks 480 queries five times over: it read p95 5.987 ms contended against 0.612 ms alone, and it
was simultaneously its three neighbours' noise. It now has its own project, `core-bench`, at
`groupOrder: 4` — after `web-bench`, because a node process burning a core on that index is exactly
what `web-bench` requires not be resident — and the four group-0 projects pin `maxWorkers: 2`, which
is one worker per core across the group rather than a tuned number. Measured over the group's 114
files and 4,241 tests: uncapped 48 s with three failures, capped 73 s with none. **Again no threshold,
timeout or assertion moved** — the budgets now measure the code instead of the scheduler, and the
whole suite is green twice over at 266 files and 6,098 tests.

### `quote_ticks` has two writers (latent, not yet firing)

`docs/WORKPLAN.md` names `packages/server/src/plant/store.ts` the only writer of `quote_ticks`.
There are two:

| Writer | Dedup |
| --- | --- |
| `packages/server/src/ingest/jobs/cboeQuotes.ts` `insertQuoteTicks` | `WHERE NOT EXISTS (md_line_id, capture_ts, kind)` |
| `packages/server/src/plant/store.ts` | none |

No duplication happens today: `index.ts` builds the plant with a database handle, but nothing passes
that plant to the scheduler's `JobContext`, so `plant.apply` is never reached from a job and only the
guarded writer runs. `packages/server/src/ingest/scheduler.ts` marks the gap ("Wiring adds
`providers`, `plant` and `hotset` here").

**The moment a plant is wired into the job context, every Cboe poll writes each tick twice** and
WP-05's row-count idempotency tests fail. Whichever package does that wiring must first pick one:

1. Delete `insertQuoteTicks` and let the job reach the table only through `plant.apply` →
   `store.writeTick`, which is what the workplan describes. The store then needs the dedup guard
   that currently lives in the job.
2. Add a unique index on `(md_line_id, capture_ts, kind)` — permitted on the partitioned table
   because `capture_ts` is the partition key — and let both writers use `ON CONFLICT DO NOTHING`.

Not fixed in WP-06 because both options reach outside it: the first edits a WP-05 file and moves
behaviour the plant cannot yet exercise, the second changes the documented schema. Neither should be
done on speculation, and a third writer's worth of duplicated dedup logic would be worse than the
gap.

### All forty function codes exist — as 38 manifests and two aliases

**This heading read "Fourteen of forty function manifests exist", and had since WP-09 — it was still
there two work packages after it stopped being true.** The catalogue is complete: `packages/core/src/functions/manifests/` holds 38 manifests,
`IB` is an alias of `MSG` and `ICVS` an alias of `CRVF` (with `aliasParams { curveId: 'SOFR_OIS' }`), and
BRIEF §1 L127-130 writes both of those pairings itself (`MSG`/`IB`, `CRVF`/`ICVS`). `packages/web/src/
screens/` has a screen for every one of the 38. `FUNCTIONS_TIER3.md` has a separate `### ICVS` entry
proposing ICVS as a manifest of its own (curve-vs-curve comparison) with its own payload; that is a
catalogue change and `manifests/CRVF.ts` records the decision not to make it.

The registry globs that directory, so a throwaway fixture manifest must never be written there, or
`GET /functions` serves it. Tests that need a manifest build one with `defineFunction()` inside the test
file, as WP-08's do.

`runner.ts` holds two guards for resolver authors: `assertPayloadMeta` refuses a payload carrying a
cell whose number cites no provenance — per cell, not per payload — or a null with no
`meta.unavailable` entry (DATA-10), and `assertProvenanceExists` refuses a citation to a
`provenance` row that is not there. Both throw in dev and test and warn in production. A resolver
that leaves `provIdx: -1` on a cell holding a price fails its own tests, so the resolvers WP-10 and
WP-11 add inherit the rule rather than the exception.

### The last backlog pass: eight findings, and what became of the six it left open

The repair pass that closed the last tier of the backlog is in commit `557b71f`. Three findings were
defects and were fixed there; four were comments that overstated or misdescribed what they left behind,
and those were corrected in place; and six items were left open because each one was recorded only inside
the comment of the file it was in, which is the one place a reader looking for open work does not look.
One of the six was found by writing a test for another.

**Four of those six are now closed, and the paragraphs below are kept with their outcome marked rather
than deleted** — each one says what was wrong, and a reader who remembers the old behaviour should be
able to find out where it went. **Two are still open:** `field_licence` cannot admit a pair without
naming a publisher, and the e2e gate's timing assertions remain a property of a quiet machine.

**The four corrected comments**, so that a reader who remembers the old numbers knows they moved.
`startup.ts`' `fieldsWithoutLicence` said this build has "twenty" dictionary fields with no
`field_licence` row, "recorded in `fn-parity.test.ts`'s census": it is **32**, the census is a
different quantity (eighteen refused exports over 71 pairs naming 38 field ids), and the figure is now
pinned as a literal beside the derivation in `test/integration/startup.test.ts`. `routes/usage.ts`
said the e2e spec "asserts only that the figure is above zero"; it also asserts `<= 500 ms`, which is
the first open item below. `providers/licences.ts` argued against an attribution it then made 117
times. `chart/layers.ts`' intraday-zone fix moved a committed pixel golden and said so nowhere — the
golden now carries a `history` entry, verified by reverting the one expression and reproducing the old
hash exactly.

**Fixed.** `command/dispatch.ts#problemFor` no longer carries a span for a run failure: every
problem a GO produces lands after `App.tsx#onGo` has cleared the input (unconditionally, before the
request, CLIENT §2.5 L783), so a surviving span could only mark nothing or underline the NEXT
command. Reproduced in Chrome on slot 6 and then withdrawn: `ZZZZ US Equity DES <GO>` with
`AAPL US Equity` typed while it was in flight read `BAD_IDENTIFIER: nothing resolves 'ZZZZ US
Equity' — AA` with `AA` marked, and now reads the same line with nothing marked. The code mapping is
untouched. That file's own previous docstring illustrated the defect with `FXC <GO>` → `AAP`, which it
could not have produced: `INTERNAL` is not a mapped code and already took the `[0, 0]` branch. The
example is now the one that was measured. `fixtures/seed/workspaces.json`'s `p3` history entry became `SPX Index GP 5D`: `range` is
`GP.paramGrammar`'s first POSITIONAL slot, so the `RANGE=5D` spelling the fixture held answers
`ARG_PARSE: RANGE is not an argument of this function` (driven in Chrome; a recalled entry would have
run the chart at GP's `1Y` default, which is the empty canvas the range change existed to fix), and
`test/unit/seed/workspaceHistory.test.ts` now parses every seeded history entry through the shipped
parser. And `chart/scales.ts`' suite now renders a chart with three `sub` study panes, which no
golden or spec did: `targetYTickCount`'s ceiling was asserted only against GP's volume pane, and
reverting it puts five y labels into a 20 px study pane.

**~~`routes/status.ts` pools two quantities into one percentile.~~ CLOSED in `557b71f` — the same
commit that wrote this paragraph, which is why the two disagreed for one commit.** What was true:
`timings.fnLaunchP95Ms` was `percentile_cont(0.95)` over `usage_events.duration_ms` for
`kind = 'fn.launch'` with no `clientReported` predicate, so it mixed the client's GO → first paint with
the runner's own duration. Four runs of `command-line.spec.ts` read `W` at 207.0, 236.4, 403.0 and
739.2 ms with no change to the server. The fix is the predicate at `routes/status.ts` L331
(`AND NOT coalesce((details ->> 'clientReported')::boolean, false)`), chosen because FUNCTIONS.md §588
makes the server runner authoritative and `/usage/functions` already excluded the client's rows; the
section "`GET /status` published a p95 of neither quantity" above has the whole of it, including the test
that writes a 9,000 ms client row beside a 42 ms server row.

**The e2e gate's two timing assertions pass on a quiet machine and not otherwise.**
`command-line.spec.ts` `:410` (WEI go → first paint p95 vs a 500 ms budget) measured 472.4 ms on slot 6
over 20 samples — 27.6 ms of room — and has been seen at 1045.2, 897.5, 536.1, 489.4, 483.0 and
472.8 ms across runs: between 11 and 28 ms of headroom when it passes, and over budget twice.
The server is not the cause —
`POST /functions/WEI/run` is a stable 335-420 ms over 25 consecutive calls. So `44/44 passing` is a
property of a quiet machine, not of this tree; siblings running Playwright concurrently is a normal
condition here by design. **This half is still open.**

The closing run of the backlog is that quiet machine, and both read inside budget with the headroom
this paragraph predicts: `:410` p95 **472.1 ms** of 500 over its 20 samples (411 … 480 ms, so no
single launch was over), and `:475` `DES 103.9 · GP 152.2 · HP 79.8 · TOP 59.6 · W 199.1 · WEI 489.6`,
where the budget binds every code but `WEI`. **The `:475` half is no longer pooled** — that was fixed in
the same commit, above — and the fourfold swing this paragraph used to attribute to pooling (`W` at
199.1 ms here against 739.2 ms in the row above) had a second cause that was found afterwards and is
the larger of the two: four vitest projects defaulted into one scheduling group with `maxWorkers` unset
and each sized its own pool at `availableParallelism() - 1`, up to 28 workers on 8 cores. Two runs since
the fix, on the same quiet machine: `:410` p95 **494.3** and **483.9 ms**, `W` at **233.4** and
**219.8 ms**. The variance is now of a size a 500 ms budget with 16 ms of headroom can still lose to,
which is why the first half of this paragraph stays open.

**`field_licence` cannot admit a pair without naming a publisher.** `providers/licences.ts`' gap fill
gives each of 117 declared-but-unobserved `(field, asset class)` pairs the field's `sources[0]`, which
states things nobody contracted for: ten land on `cboe.quotes`, including `(PX_BID, crypto)` and
`(PX_ASK, fx)`, where `PX_BID`'s observed paths are equity/etf/index → `cboe.quotes` and option →
`cboe.options`. The alternative was leaving two doors disagreeing about the same field, which is what
`(BID_SIZE, index)` was, so the trade is argued in that file and asserted in
`test/unit/providers/licences.fieldMatrix.test.ts`. The honest shape is a row that admits a pair with
no source; `field_licence.source_id` is `text NOT NULL` with `assert_source_known()` on it (migration
`0002` L72-80), so that needs a migration and a rule-1 change.

**~~`GP`'s `R` is declared and not wired, and the keyed `RANGE=` spelling survives in `MSG`.~~ CLOSED in
`786d5e3`, and the MSG half was two commands, not one.** What was true: `cycle-range` reached
`App.tsx#screenAction`, which answered `NOT_APPLICABLE: … declared by the screen but not wired yet`
(driven in Chrome), while `GP/Screen.tsx` L196 titled every range chip `press R to cycle to 1M` — so the
default desk's chart could not be moved off its range from the keyboard at all. And `functions/MSG`'s
chart click-through emitted `AAPL US Equity GP RANGE=1Y`, a command the parser refuses. See "The four
small defects, closed" below: the channel is `ScreenSpec.actions`, the spelling is
`core/command/args.ts#formatArgs`, and parsing the commands rather than reading them found `PORT 7` as
well.

**~~The bottom pane of a multi-pane chart pays for the x strip out of its own band.~~ CLOSED in
`786d5e3`.** What was true: `layers.ts#computeLayout` shared the full canvas height out by the
`panes[].height` fractions and only then trimmed `xAxisHeightPx` off whichever pane was last. Measured on
GP with the volume pane and three `sub` studies in a 400 px canvas: `main` 288 px, `vol` 37, `st0` 20,
`st1` 20, **`st2` 3**. The strip is now reserved before the fractions and given back to the last open
pane's band. The pin in `test/chart/scales.test.ts` did its job: it was bounded ABOVE so a fix would
arrive as a failure with the new geometry in it, and that is how it arrived.

**~~`CommandLine.tsx` L400-401 still says GO leaves a refused command on the line.~~ CORRECTED.** It did
not — `onGo` clears unconditionally — and nothing depended on the claim once `problemFor` carried no span,
but the docstring was the last place that stale story was told. It now says what the snapshot actually
is: the draft the user has typed SINCE the problem was raised, which is why `problemFor` withdraws the
span for answers that are not statements about the command.

### The four small defects, closed — and a second command that could not be clicked through

Each of these four was recorded as open and each was reachable by a user: a key the screen advertised
and did not answer, a chip the parser refused, a study pane three pixels tall, and a reserved key with
no on-screen path at all. One of the four turned out to be two.

**`ScreenSpec.actions` — a screen's own keys had no channel to arrive on.** `manifests/GP.ts` declares
`{ key: 'R', action: 'cycle-range' }`, the dispatcher matched it, and `KeyboardHost.screenAction` had
nowhere to send it: a grep for any action id over `packages/web/src` found only the declarations, so
every one of them answered `NOT_APPLICABLE: declared by the screen but not wired yet` while
`GP/Screen.tsx` titled all ten range chips "press R to cycle to <r>". The channel is a new optional
`ScreenSpec.actions`, published with the rest of the focus model by `Panel.tsx` and run by
`App.tsx#screenAction`; GP wires the twelve bindings that are a param change or a navigation, and the
chips now title the ONE chip `R` goes to. The hint survives for the four that need `ctx.prompt`, which
resolves `null` until `PromptDialog` exists — asserted absent, so wiring a prompt dialog fails that test
and brings the author back. `ScreenCtx.setParams` was widened to `{ [K in keyof P]?: P[K] | undefined }`
because cycling off `range: 'CUSTOM'` must CLEAR `start`/`end`: `planWindow` measures a fixed range back
from `params.end ?? today`, so a surviving `end` would run `1D` against a day in the past with nothing
on screen saying so.

**MSG's click-through, and `PORT 7`.** The resolver upper-cased every param name into `KEY=value`,
emitting `AAPL US Equity GP RANGE=1Y` — `range` is GP's first POSITIONAL slot and `RANGE` is in no
`keyed` map, so the parser answered `ARG_PARSE: RANGE is not an argument of this function`. The same
spelling had already been found once, in `fixtures/seed/workspaces.json`; twice is a missing function.
`core/command/args.ts#formatArgs` is the inverse of `parseArgs` — positionals as a leading run, keyed
with the grammar's own key, booleans `Y`/`N`, arrays and objects DROPPED AND NAMED rather than flattened
(a repeated keyed token overwrites in `parseArgs`, so `VS=A VS=B` would round-trip to `B` alone, and a
command that parses and means something else is worse than one honestly missing a param). Three
structured coercions invert exactly and are spelled; `{ id }` from the universe is dropped, because no
token spells an instrument id and inventing `1000` would write a command that parses as the ticker
"1000". **The second defect was found by parsing the commands rather than reading them:** the portfolio
chip emitted `PORT 7`, and `portfolioId` is PORT's keyed `P=` while its positional is a `view` enum, so
that chip could not be clicked through either. `MSG.test.ts`' chart assertion had read
`expect(chart.command).toBe('AAPL US Equity GP RANGE=1Y')` — a test checking its own setup artefact —
and now parses; a loop over every resolvable chip parses the rest. `formatArgs.test.ts` round-trips
params → tokens → params over all 38 shipped grammars, and asserts that every key it loses is a key it
names.

**The bottom pane of a multi-pane chart no longer pays for the whole x strip.**
`layers.ts#computeLayout` shared the full canvas height by the `panes[].height` fractions and only then
trimmed `xAxisHeightPx` off whichever pane was last. `xAxisHeightPx` now comes out of the height the
fractions divide and is given back to the last open pane's BAND, so the strip is shared furniture paid
for in proportion. GP with the volume pane and three `sub` studies in a 900 × 400 canvas went from
`main 288 · vol 37 · st0 20 · st1 20 · st2 3` to three study panes within a pixel of each other. **No
committed pixel hash moved, and that is a property rather than luck:** for a single open pane the new
arithmetic is the old arithmetic (`openHeight = H − strip`, band `= openHeight + strip = H`, plot
`= band − strip`), and all twelve cases of `series-hashes.json` are single pane. `scales.test.ts` pins
that identity, and its `toBeLessThan(8)` — written bounded above precisely so a fix would arrive as a
failure with the new geometry in it — is now a comparison against the sibling pane.

**`shell/KeyBar.tsx` exists.** `Shell.tsx` had carried the `keyBar` slot since WP-12 and nothing passed
it, so CLIENT §5 L348's "every binding has an on-screen equivalent" was false and §18.6 Q6's GUARANTEED
path for `F11` — which macOS Chrome does not surrender to a page — did not exist: `F11` had no reachable
binding of any kind. The bar is `GO CANCEL MENU HELP PRINT PG▲ PG▼` and the ten yellow sector keys,
derived from `yellowKeyForSector` so it cannot disagree with the table the dispatcher matches (`Crypto`
answers `null` and is absent from both). **A button presses the key:** `onKey` hands a
`KeyboardEventInit` to the same `dispatcher.handleKeyDown` the window listener calls, so the two are one
implementation. That is what makes `MENU` correct — `MENU` and `CANCEL` are both `Escape`, and a bar
that called `popFrame()` directly would pop the frame out from under an open overlay; the ladder decides,
and a mutation that sent `Alt+ArrowLeft` for `MENU` reddens the test that presses it twice.

`settings.keybar` became three-state (`'auto' | 'on' | 'off'`, legacy `true`→`'auto'`, `false`→`'off'`).
A boolean cannot express §3.3's "hidden in density `compact` unless `/keybar on`": it cannot tell the
default-on of a normal desk from an explicit on, so either `/keybar on` does nothing in compact density
or compact density never hides the bar. **`/keybar on|off|auto` is a NINTH shell command and a stated
deviation** — FUNCTIONS.md §2.6 L792-794 lists eight — taken because without it a compact desk can reach
`F11` by no path at all, which is the defect the bar was written to close, one layer up.

Gate: 269 files / 6,214 tests green (was 266 / 6,098); 44 e2e green, exit 0, WEI p95 483.9 ms of 500;
`bloomberg_test` still unseeded at `instruments=0 / licence_registry=33`; no NUL byte in 645 production
source files. Every fix was mutation-checked — eleven mutations, each reverted and confirmed red,
including the original spelling (`KEY=` for a positional) which reddens the round trip for every grammar
that has one.

### This is a Postgres 14 build and Postgres 14 goes EOL in November 2026

Found by running the deployment preflight against a free Neon project on 2026-10-06, which answered
**PostgreSQL 18.6**. `docs/DATA_MODEL.md` L1 says "final Postgres 14 data model" and L20 records that
every migration was verified against a scratch 14.17 database; `ARCHITECTURE.md` names Postgres 14 at
L45 and L1226; the development machine is 14.17; and all 6,214 tests have only ever run against 14.

Pinning a deployment to 14 to match would put it on a major version that stops receiving security
fixes within the month, so the move is not optional. The deployment did not create this; it surfaced
it, about four weeks before it would have become urgent on its own.

**What the preflight already proves about 18.6**, which is the surface most likely to break: all four
extensions (`uuid-ossp`, `btree_gist`, `pg_trgm`, `pgcrypto`) install, `CREATE ROLE` works for a
non-superuser owner holding `CREATEROLE`, RLS with a `SECURITY DEFINER` function bypassing a
non-`FORCE`d policy works, and declarative range partitioning with attached children works. One known
hazard is handled in our own SQL rather than by luck: Postgres 15 removed `PUBLIC`'s implicit `CREATE`
on schema `public`, and `0015_roles_rls_worm.sql` L10/L67 grant schema privileges explicitly.

**MEASURED, 2026-10-06: the schema is Postgres 18 clean.** 18.6 installed beside 14 (keg-only, so
14's binaries stay first on `PATH`) and started on port 5433. All **19 migrations applied, exit 0**.
Against a migrations-only 14 database the counts match exactly — 148 tables, 6 partitioned, 383
indexes, 6 views, 154 checks, 140 FKs, 154 PKs, 20 uniques, 21 exclusion constraints, 23 of our own
functions, 20 policies, 11 enums. A `pg_dump --schema-only` of both through the **same** 18.6 binary
left only cosmetic differences: `pg_dump`'s own nonce, one comment, and the six bitemporal views,
which an 18 server deparses without the table qualifier and which return identical columns (100,
same names, order and types).

Three raw counts moved and all three are the catalogue, not the schema: `pg_constraint` 489 → 1666
(PG 17+ catalogues NOT NULL — 1,177 rows of `contype='n'`, every other type identical), functions
279 → 313 (extension-owned only), and visible triggers 45 → 53 (**PG 15 flipped `tgisinternal`** for
partition clones). That last one was checked functionally rather than by counting: `UPDATE` and
`DELETE` on `access_log` are refused on **both** versions with the identical message, `table
access_log_m2026_10 is append-only (WORM)`, naming the partition — so the clone trigger fires either
way and the audit log is as append-only on 18 as on 14.

**The suite on 18, and the four things running it found.** None of the four is Postgres 18's fault,
and three of them were in this tree on 14 all along.

1. **The suite depended on a `C`-collated cluster, and nothing said so.** The 14 cluster was
   `initdb`'d with `datcollate = C`; brew's 18 cluster with `en_US.UTF-8`. One assertion of 6,214
   failed — `worldMacro.test.ts`'s IMF series list — because a locale-aware collation weights the
   underscore differently (`NGDP_RPCH` after `NGDPDPC` under `C`, before `NGDPD` under
   `en_US.UTF-8`). Proven to be the collation and not the version by running it on a `C`-collated 18
   database: green. **One failure was luck** — real field ids reorder completely between the two
   (`CHGPCT CHG_PCT_1D PXL PXV PX_ASK …` against `CHG_PCT_1D CHGPCT PX_ASK PX_BID …`), and no committed
   golden happens to order rows by such a column. Fixed at the root: the two orderings whose
   docstrings promise a "stable walk" (`ingest/jobs/worldMacro.ts#seededTargets`,
   `ingest/jobs/blsSeries.ts`) now pin `COLLATE "C"`, the third (`seed/rates.ts`) is left bare with a
   note saying why — it feeds a `Map`, so its order is unobservable — and startup step 3 now reads the
   collation (`startup.ts#checkCollation`) and **warns** with the exact remedy. A warning and not a
   refusal, on the `loadCalendars` principle: a collation is a property of the host, and a managed
   Postgres usually defaults to `en_US.UTF-8`.

2. **Every knowledge instant was floored to the millisecond, on 14 and 18 alike.** `knowledgeInstant`
   read `clock_timestamp()` (microseconds) and returned a JavaScript `Date` (milliseconds). Measured:
   every stored `tx_from` ended in `000`. Two writes of one key inside one millisecond got the same
   instant, the close set `tx_to = tx_from`, and `bt_guard_update` refused a legitimate write. It showed
   on 18 as a flake because a `writeVersion` takes ~1.5 ms there against ~3 ms on 14 — measured on the
   real write path. (A bare-round-trip probe made it look like speed was irrelevant: same-millisecond
   pairs ~80% on both. That was the wrong proxy, and it briefly led to the wrong conclusion.) Faster
   hardware would have found it on 14. A 200-version chain test reproduced it **5 of 5 on 18** and is
   now green 5 of 5 on both; stored instants carry real microseconds (`.810348`, `.081814`).
   The fix is `KnowledgeInstant { iso, at }`: `iso` is formatted in the database to the microsecond and
   is the only form ever bound; `at` is a `Date` for the minute-scale future check. `ExactAsOf` is
   wider than `AsOf` rather than a change to it, so **none of the 208 sites reading `AsOf.knownAt`
   changed**, and a caller's plain `Date` still binds byte-identically. One trap found on the way:
   drizzle's `sql` template accepts any value, so the compiler would NOT have caught an instant object
   bound raw into SQL — two such sites in `retireVersion` were found by a fixed-string search after a
   regex search falsely reported none. Mutation: reintroducing only the floor → red 3 of 3.

3. **An e2e spec had a three-week shelf life, and the fix uncovered a parser defect.**
   `export.spec.ts` ran `AAPL US Equity HP 1M` — a window ending TODAY — over bars frozen at
   2026-09-15. It held 15 sessions when written and 6 on 2026-10-06, when it failed its floor of ten on
   14 and 18 alike. Moved to a fixed window, `CUSTOM 2026-08-25 2026-09-15`: exactly 15 sessions, which
   is also the size the virtualised grid is known to show whole, now asserted exactly rather than as a
   floor. **That spelling did not parse.** HP's help says "1M … MAX, or CUSTOM with two dates" and both
   `HpRange` and `GpRange` include it, but the parser's base list has no `CUSTOM` and neither range slot
   declared `values` to extend it. Fixed by the mechanism the grammar already provides
   (`values: HpRange.options` / `GpRange.options`), with `core/test/command/customRange.test.ts`.

   **OPEN, and recorded rather than fixed:** typing the dates WITHOUT `CUSTOM` —
   `HP 2026-08-25 2026-09-15` — parses to `{ start, end }` with `range` at its `1Y` default, and
   `server/src/functions/HP/window.ts#resolveWindow` reads `start` only in the `CUSTOM` branch. So the
   screen shows a year ending 15 September and **silently drops the start date**. GP's `planWindow`
   has the same shape. A silent wrong answer, not an error — but it changes resolver behaviour for two
   functions, so it gets its own pass. `customRange.test.ts` pins the current behaviour so the fix
   arrives as a failing assertion.

4. **Four timeouts on 14, not reproduced.** In one full run, three DB-heavy files took ~32 s on 14
   against ~1.5 s on 18 with identical code — all three together, which looks like a lock wait. In
   isolation all 35 tests pass in ~2-3 s each, and two full 14 runs earlier the same day were clean.
   Classified as contention in that run (it followed two back-to-back 18 suites on one machine); the
   re-run gate is the evidence either way.

**For deployment** (`docs/DEPLOYMENT.md` §3): finding 3 is not only a test problem. A replay-mode site
serves bars frozen at the capture date while every relative window (`1M`, `1Y`, `5D`) ends on the wall
clock, so **the deployed terminal would show fewer bars every day and empty charts within weeks.**

### A sign-in form, with a second factor by email — and six defects building it found

`DEPLOYMENT.md` §4.1, decided 2026-10-06. The terminal had no sign-in screen; now `Gate`'s
`anonymous` state is a login form and its `mfa` state is a code step (`web/src/shell/SignIn.tsx`).
Behind them: `POST /auth/mfa/email/send` and `/verify` (API.md §15); migration 0020's
`mfa_email_codes`; `http/auth/emailCode.ts` (the arithmetic, pure) and `emailCodeService.ts` (where
each property is enforced in SQL); `email/sender.ts` with an `smtp` transport (nodemailer), an
`outbox` one that writes files for development and the e2e suite, and an in-memory one for tests;
`EMAIL_*`/`SMTP_*` configuration that fails closed; and `scripts/create-user.ts`, which prompts for
the password rather than accepting it as an argument.

A code is a **second factor only** — neither route can mint a session, or an inbox would be a
credential on its own — and it is **not phishing-resistant**: a proxying page can relay it like the
password. So it does not answer SEC-02, which asks for exactly that; WebAuthn does, and still has no
UI. TRACEABILITY's SEC-02 row says so.

What building it found, each one now a test that was watched failing before the fix:

1. **The window's key dispatcher swallowed every keystroke on the sign-in screen.** It was attached
   whatever the session state, routed each key to type-anywhere for a command line that did not exist
   yet, and called `preventDefault` — so the login form could not be typed into. Found by
   `App.test.tsx`'s journey; fixed in `App.tsx` by dispatching only once the session is `ready` and
   never a key something else already handled. `login.spec.ts` types with `pressSequentially`, never
   `fill`: `fill` sets the value without a `keydown` and would have passed against the bug.
2. **Two sends at once bypassed both send limits.** `send` read the session's history before its
   transaction, so a second request read it while the first one's row was uncommitted, passed the
   cooldown and the five-code cap, could not see the first row to supersede it, and mailed a second
   code — as many as requests fired. Found while writing API.md's description of the limits. Fixed as
   `session.ts#create` serialises logins: an advisory lock keyed on the session, taken first, with the
   history read after it. `mfaEmailConcurrency.test.ts` holds the first send open inside the transport
   on a real connection; before the fix the second message went out while the first was held.
3. **A new account's first workspace load could answer 500.** `GET /workspace` creates the default
   desk on first read; two first reads at once both found none, both inserted, and the loser failed on
   `workspaces_user_id_name_key` (23505 → `500 INTERNAL`). Every seeded account already has a desk,
   so nothing exercised the path — and every `create-user` account takes it. Found by `login.spec.ts`,
   whose request raced the shell's own first load, in the plant's log: the spec's assertion was "not
   401" and let the 500 through. Fixed with `ON CONFLICT DO NOTHING` and a re-read
   (`firstLoadRace.test.ts`, which holds the other insert uncommitted on a second connection); checked
   by hand under `terminal_app` with RLS on. The spec now asserts exactly 200.
4. **A failed resend locked the person out of a good code.** The code step disabled its box whenever
   a send failed, including a resend after a code had already gone out — but a failed send rolls back
   and supersedes nothing, so that code still worked. The same at the five-code limit. Both now keep
   the box and say why (`signIn.test.tsx`).
5. **Signing out would have handed the last person's state to the next.** Before the form, a sign-out
   (`/logout`) could only end at the gate. With a form on the gate, the next person signs in on the
   same page — and the stores are module singletons: the shell draws the last person's panels before
   it restores the new workspace, a workspace autosave still on its debounce would go out under the
   new person's cookie, and the session store had dropped the port it refreshes quotas through. Both
   sign-out doors (`/logout`, and "Use a different account" on the code step) now end in a page
   reload (`App.tsx#signedOut`), the one reset nothing can be left out of. `App.test.tsx` covers both.
6. **A test that could not fail.** The first supersession test exhausted the new code and expected the
   old one to stay dead; with supersession switched off it still passed, because `verify` reads only
   the newest live code. It now asserts the rows (`mfaEmail.test.ts`, the comment above it).

Smaller: the first `npm install nodemailer` resolved to a major with high-severity advisories (all
≤ 10.0.5); it is `^10.0.15`, with no `@types` package needed. `deviceLabel` reported an iPhone as macOS
— its agent says "like Mac OS X" — until the mobile platforms were tested first. API.md said the seed
sets `mfa_required` for `admin` and `compliance`; the seed has no admin, and sets it false on every row.
The schema contract moved with the schema: CONTRACTS §1.2 and `db/migrate.test.ts` now name 95 tables
and 20 migrations. The new contract text is APPENDED — API.md §15, DATA_MODEL §22 — rather than
inserted where it belongs, because over three hundred comments cite those two files by line number
and an insertion would have silently moved every one after it.

**OPEN, recorded rather than fixed:**

- **The session token is not rotated when the second factor upgrades it.** `markMfaVerified` flips
  `mfa_verified` on the cookie the password step set, so a token captured between the two steps
  becomes a full session once the code is entered. WebAuthn's upgrade path does the same; the fix
  (mint a new token at the upgrade, revoke the old) belongs to both together.
- **`create-user`'s interactive prompt is untested.** The non-TTY path (`CREATE_USER_PASSWORD`) was
  run against a scratch database and its rows checked; the no-echo TTY prompt was not.
- **`scripts/` is outside `npm run typecheck`** (`tsc -b` builds the packages only), and vitest
  strips test files' types without checking them. `tsconfig.eslint.json` reports 179 errors, all in
  test files and none from this change; 58 have one cause, `import userEvent from
  '@testing-library/user-event'` (the default export), where the named `{ userEvent }` checks clean.
- **A `.env` copied before this change has no `EMAIL_TRANSPORT`**, so a `create-user` account cannot
  finish signing in locally until the two lines from `.env.example` are added. Failing closed is
  deliberate; the README says what to add.
- **The e2e login budget is shared.** `globalSetup` spends the five-a-minute login allowance on the
  accounts it pre-mints, so `login.spec.ts` meets `429` on a full run and waits it out (~55 s) the way
  a person would — the same position `entitlement.spec.ts` is in, and for the same reason the limit is
  not widened for the harness.

Gate: 277 files / 6,321 tests green on Postgres 14 once and on Postgres 18 twice (was 269 / 6,214);
47 e2e green on each, exit 0, no error-level line in either plant's log, WEI p95 455.3 ms (14) and
411.5 ms (18) of 500; `bloomberg_test` still unseeded at `instruments=0 / licence_registry=33` on both.
Each of the six defects above was watched failing before its fix. The e2e template databases were
rebuilt with migration 0020 on both servers by running the `server-seed` project — a database that
predates a migration makes the plant refuse to start, so the same is owed after any later one.

## Notes

- `packages/server/src/test/fixtures.ts` resolves `REPLAY_DIR` against `packages/server` while the
  repo `.env` carries the root-relative `./fixtures/providers`, so a test reading a normalised
  fixture has to pin `process.env.REPLAY_DIR`. Three tests do. Worth fixing centrally in WP-15.
- There is no metrics registry yet. The plant and the conflator expose counters through `stats()`.
- `packages/server/src/ws/gateway.ts` takes injectable authentication, entitlement and quota ports.
  WP-07's evaluator is now on `AppDeps.entitlements` in both `index.ts` and `src/test/app.ts`, so the
  fail-closed `denyAllEntitlements` default is only reached by a host that wires neither. Tests may
  still inject a fake implementing the rules of ARCHITECTURE §10.
- `RP_ID` and `RP_ORIGIN` are new required-in-practice configuration (SEC-02). They are the values
  the two anti-phishing checks of a WebAuthn ceremony compare against, and they are NEVER derived
  from the request's `Host`/`Origin` — that would compare an attacker's value with itself. Unset,
  every `/auth/webauthn/*` route fails closed with a 500.
- Scope enforcement is at the point of use: `requireSession({ scopes: ['data:read'] })` on the
  `/usage` reads and a `ws:subscribe` check in `ws/session.ts`'s `sub` handler. `fn:run` has nowhere
  to be checked yet — WP-08 owns the function routes and must pass it there.
- `packages/server/src/data/request.ts#gateFields` now DENIES when no entitlement port is wired.
  WP-08 wires the data routes: pass a real evaluator, or `allowAllEntitlements` explicitly.
