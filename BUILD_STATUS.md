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
| WP-07 | Entitlements, auth, access log, quotas, compliance | not started |
| WP-08 | Function runner, REST routes, field surface | not started |
| WP-09 … WP-15 | Screens, SDK client, web shell, seed and verification | not started |

The suite runs with no network access: the replay store is a wall, and a fixture miss throws rather
than falling through to a provider (FEED-08, QA-02).

## Open issues

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

## Notes

- `packages/server/src/test/fixtures.ts` resolves `REPLAY_DIR` against `packages/server` while the
  repo `.env` carries the root-relative `./fixtures/providers`, so a test reading a normalised
  fixture has to pin `process.env.REPLAY_DIR`. Three tests do. Worth fixing centrally in WP-15.
- There is no metrics registry yet. The plant and the conflator expose counters through `stats()`.
- `packages/server/src/ws/gateway.ts` takes injectable authentication and entitlement ports. Until
  WP-07 lands its evaluator, the default entitlement port is fail-closed: every field is denied with
  `NO_FIRM_ENTITLEMENT`. Tests inject a fake implementing the rules of ARCHITECTURE §10.
