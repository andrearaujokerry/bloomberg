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
| WP-14 … WP-15 | Charts and studies, seed and verification | not started |

5,040 tests across 234 files.

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
