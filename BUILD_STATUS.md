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
| WP-10 … WP-15 | Tier 2/3 screens, SDK client, web shell, seed and verification | not started |

3,631 tests across 176 files.

The suite runs with no network access: the replay store is a wall, and a fixture miss throws rather
than falling through to a provider (FEED-08, QA-02).

## Open issues

### WP-09 shipped with 24 audit findings unapplied, 6 of them blockers

The WP-09 integration round stalled on all six attempts and never applied the adversarial auditors'
findings. The package is green and complete as built; these are defects the audit *found* and nobody
has yet fixed. They are listed here rather than in a commit message because they are work, not
history. Fix the blockers before this terminal handles a real message or a real news feed.

**Messaging and tenancy (the serious cluster).**

| Where | Defect |
| --- | --- |
| `messaging/service.ts` | `createRoom` is broken under the role the server actually connects as: the row it returns is not visible to the members policy because the creator is not a member yet. |
| `messaging/service.ts` | MSG-02 surveillance records nothing in production. The scan runs in the sender's transaction where `app.role` is `user`, the policy refuses the insert, and the savepoint rolls it back silently. |
| migration `0015` | `surveillance_hits_compliance` and `message_reviews` policies have no firm scoping, so any compliance user at any firm reads every firm's flagged message text. |
| migration `0015` | `room_members_visible` has a vacuous `WITH CHECK`, so any authenticated principal can insert their own membership row into any room. |
| `messaging/service.ts` | The hash chain is not anchored. Editing a message and recomputing the suffix verifies clean, and a room can be rewritten from seq 1. Needs `rooms.last_seq`/`last_hash` or an append-only anchor table. |
| migration `0015` + `service.ts` | The chain digest omits `structured`, `sender_firm_id`, `client_msg_id` and `trace_id`, so a stored order can be rewritten without breaking the hash. |
| `alerts/engine.ts` | `criteriaFor()` reads a saved search with no owner predicate, on the handle that bypasses per-user visibility. |
| `alerts/engine.ts` | The engine is never constructed outside tests, so NEWS-07 alerts never fire in a running server. |

**News precision (NEWS-02).**

| Where | Defect |
| --- | --- |
| `refdata/newsDict.ts` | Precision is carried by an enumerated list of 253 ambiguous words. Any issuer whose name is an ordinary English word outside that list scores 0.9025 and is written. |
| `news/entityLink.ts` | The floor test is `confidence < 0.9`, so a value landing exactly on 0.9 passes. An ambiguous bare-paren ticker scores exactly that. |

**Payload honesty (DATA-10).**

| Where | Defect |
| --- | --- |
| `functions/runner.ts` | `assertPayloadMeta` does not enforce what WP-09 was told it enforces: one citation anywhere excuses every number in the payload. It never checks a cell's own `provIdx`. |
| `functions/Q/resolve.ts` | `lineCells()` hard-codes `provIdx: -1` on every per-line cell, including cells carrying a real price whose provenance is known twelve lines later. |
| `functions/GIP/resolve.ts` | `vwap` is a bare `number[]` with nowhere to put a citation; 311 prices ship uncited. |
| `functions/GP/resolve.ts` | Chart reference lines have no `provIdx` field at all. |
| `core/fields/defs/analytic.ts` | The `RET_*` dictionary entries describe total return while the resolvers compute price return. One of the two documents is wrong and neither has been corrected. |

**Goldens.** The Tier 1 goldens are hand-seeded rather than derived from the recorded captures, and
three hand-typed values contradict their capture outright. `HP.series`, `HELP.default` and
`SECF.default` have no committed golden at all. `HP.price.json` asserts a session on Labor Day 2020,
a day its own declared calendar says the exchange was shut.

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
number with no provenance or a null with no `meta.unavailable` entry (DATA-10), and
`assertProvenanceExists` refuses a citation to a `provenance` row that is not there. Both throw in
dev and test and warn in production. **The first is weaker than it looks — see the payload-honesty
row in the WP-09 findings above.**

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
