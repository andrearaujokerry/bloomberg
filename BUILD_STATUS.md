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
| WP-13 | LiveGrid, SDK live client, subscriptions, quote cache, realtime bridge | merged, with the wiring gap below |
| WP-14 | Chart engine, 12 series types, 22 studies, streaming, annotations | merged, with the dead-module and gap findings below |
| WP-15 | Seed, fixtures, replay harness, parity, composition root, e2e | **merged** — part 2 added the 8 Playwright specs and regenerated `docs/TRACEABILITY.md` |

5,915 tests across 254 files, plus 39 Playwright tests that `npm test` does not run. The suite is nine vitest projects; `server-seed` owns its own
database and is the only one that seeds (see below), and `packages/e2e` is Playwright and is not
run by `npm test` at all.

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

### Nothing renders `LiveGrid` yet, and no work package owns the wiring

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

### Five startup steps still say "a later work package's", so the server runs degraded

Booting it also showed what has not been wired. `src/index.ts` skips, by number:

| Step | What is skipped | Owed by |
| --- | --- | --- |
| 3 | the field dictionary and its field-id validation | WP-03/WP-11 |
| 4 | calendars and the function-registry consistency check | WP-08 |
| 5 | the universe search snapshot and its ETag | WP-09 |
| 8 | the ingest leader lock and the scheduler | WP-07 |
| 9 | the usage-event and DQ writers, and the 1 s staleness sweep | WP-08/WP-13 |

All five packages are merged; the process that runs them still defers to them, and `/health`
therefore reports `status: "degraded"` with `scheduler: false`. This is the server-side twin of the
composition-root gap WP-15 part 1 closed on the client, and it is the next thing to assign: at least
step 5 and step 9 bear directly on WP-15's own acceptance rows (the autocomplete spec's server
fallback, and the live-grid spec's staleness badge).

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

The nine expected failures are `test.fail()`, never `test.skip()`: each one RUNS on every suite, its
assertion is the one the product should satisfy and is not weakened by a millisecond, and the day it
is fixed Playwright reports "expected to fail but passed" so neither the fix nor the record can rot.

| Spec | What it records |
| --- | --- |
| `smoke.spec.ts:632` | **DEFECT** `App.tsx#onRestored` (L1135) re-runs a restored frame as `"<security> <fn>"`; the dispatcher resolves that display as a REF, so the adapter at L664 pushes a frame with `security: null` — which is then persisted. The SECOND load of the terminal restores GP with no instrument (TERM-05). |
| `panels.spec.ts:371` | **DEFECT** the same line drops the frame's `params`, so a panel saved as `W Core` (5 rows) comes back on the manifest defaults (`W · S&P 500 Top 25`, 25 rows) (TERM-05). |
| `help.spec.ts:345` | **DEFECT** `Shell.tsx` L113-123 restores the workspace in an effect keyed on `onRestored`, whose identity changes whenever the HELP overlay opens (`onHelp` → `dispatchDeps` → `onRestored`). Opening HELP therefore re-restores the workspace, and the ticket captures a screen the user never asked about (TERM-09, and a TERM-05 defect in its own right). |
| `help.spec.ts:398` | **GAP** `App.tsx#PanelOverlay` closes the dialog from `onOpened`, so `TicketDialog`'s "Ticket N opened / MSG room M" confirmation never paints. The ticket IS created (`201 {ticketId, roomId}`) and the user is told nothing (TERM-09). |
| `live-grid.spec.ts:454` | **DEFECT** `cellRegistry.ts#restyle` returns on its first line because `setStateSource()` is never called by any product file, so the client's 1 s staleness sweep never reaches a cell — the client-side twin of the server's skipped startup step 9. A dead feed leaves a `live` number on screen (TERM-12). |
| `entitlement.spec.ts:367` | **DEFECT** a value withheld by the eod grant arrives as `st: 'closed', r: 'TIER_EOD'`, not `blank`, and `CellView` prints `.cell__reason` only for `blank` — so a withheld price and a missing price are the same em dash, which is the thing the rule exists to prevent (ENTL-05). |
| `export.spec.ts:472` | **GAP** nothing in the UI invokes `ScreenCtx.export()` and the window keyboard dispatcher that would bind `Ctrl+P` is not attached (`App.tsx` L56-69). The export path is proven cell-for-cell by the test above it; the gesture is missing (FUNC-03). |
| `autocomplete.spec.ts:454` | **FINDING** `timings.autocompleteP95Ms` is a hard-coded `0` (`routes/status.ts` L460) and `perf/marks.ts` does not exist, so the channel WP-15's acceptance row names carries nothing. The budget is measured by the spec instead: p95 5.3 ms keystroke → rows, 15.7 ms keystroke → painted frame, over 84 measured keystrokes. |
| `smoke.spec.ts:508` | **SEED GAP + SUBSCRIPTION GAP** `bars_daily` has no SPX row, so `GP · SPX Index` — the first chart every seeded user sees — draws an empty canvas; and retargeting that panel at a security with history blanks a correct cell two panels away. Both halves measured below. The chart itself is proved green on AAPL (243 bars, `High 340.08`) by the test above it. |

### The default desk's chart panel plots nothing, and the obvious fix makes it worse

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

### `chart/scales.ts` is 761 lines that nothing draws with

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

**Still open:** `PSAR` and `MACD` die at a gap, and `BB`/`STDDEV` still throw rather than returning
a gapped column — now caught by the guard, so the cost is a missing pane rather than a dead chart.
Each is the same shape of fix as `emaSeries`, in its own study.

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

### Fourteen of forty function manifests exist

WP-09 wrote the Tier 1 fourteen. WP-10 and WP-11 write the rest, into
`packages/core/src/functions/manifests/`, which the generated registry globs — so a throwaway
fixture manifest must never be written there, or `GET /functions` serves it. Tests that need a
manifest build one with `defineFunction()` inside the test file, as WP-08's do.

`runner.ts` holds two guards for resolver authors: `assertPayloadMeta` refuses a payload carrying a
cell whose number cites no provenance — per cell, not per payload — or a null with no
`meta.unavailable` entry (DATA-10), and `assertProvenanceExists` refuses a citation to a
`provenance` row that is not there. Both throw in dev and test and warn in production. A resolver
that leaves `provIdx: -1` on a cell holding a price fails its own tests, so the resolvers WP-10 and
WP-11 add inherit the rule rather than the exception.

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
