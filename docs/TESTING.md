# TESTING — the strategy that proves the terminal works, offline

This document is the test contract. It fixes the pyramid, the runner configuration per layer, the
database harness, the npm script names, the golden analytics datasets with their expected values and
tolerances, and the file path of every test. It is the answer to QA-01, QA-02, QA-05, ANAL-08, ANAL-09
and the NFR latency table, and it is what makes the BRIEF §7 definition of done ("`npm test` passes
offline in CI conditions") checkable.

Names used here — tables, columns, enums, routes, wire message types, exported declarations, module
paths — are taken from [CONTRACTS.md](./CONTRACTS.md). Anything this document needs that CONTRACTS.md
does not define is collected in §17 *Additions required*; nothing is invented silently.

## 0. Principles

1. **Offline is a wall, not a preference.** Every suite runs with `PROVIDER_MODE=replay`
   (ARCHITECTURE §8.1). A replay miss throws `ReplayMissError` and fails the test; it is never converted
   to a `dq_events` row and never retried against the network (PROVIDERS §3.6). `npm run test:live` is
   the only script that may reach a provider, and it is never part of CI.
2. **Determinism is designed in, not hoped for.** Time comes from `Clock` / `VirtualClock`
   (`packages/server/src/test/clock.ts`), randomness from `xoshiro128ss` seeded per subject
   (`providers/sim/prng.ts`), ordering from insertion sequence. No test calls `Date.now()`,
   `Math.random()` or the platform `setTimeout`. A test that needs a wall clock is a bug report.
3. **One implementation, one test.** `core/quote/staleness.ts#valueState`, `core/fields/format.ts#format`,
   `core/adjust/corporateActions.ts` and `core/functions/csv.ts` are each the single implementation of
   their rule; tests assert on them directly and assert that nothing else re-implements them
   (`packages/web/test/no-direct-io.test.ts`, `packages/web/test/format/no-arithmetic.test.ts`).
4. **Expected values are committed, not computed by the code under test.** A golden dataset holds inputs,
   expected outputs and a tolerance. Regenerating a golden is a reviewable diff
   (`npm run golden:update`), never a side effect of a test run.
5. **Every number carries provenance, so every test asserts it.** A function-level test that checks a
   value also checks that `meta.provenance[]` is non-empty and that the cited index resolves (DATA-10).

---

## 1. The pyramid and the tooling per layer

| # | Layer | Package / directory | Runner | Environment | DB | Network | Target count | Wall-clock budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Pure unit | `packages/core/test/**` | vitest 5 (project `core`) | `node` | none | none | ≈ 900 | < 25 s |
| 2 | SDK / wire | `packages/sdk/test/**` | vitest 5 (project `sdk`) | `node` | none | fake `WebSocket` | ≈ 120 | < 10 s |
| 3 | Server unit | `packages/server/test/unit/**` | vitest 5 (project `server-unit`) | `node` | none (stubs) | none | ≈ 300 | < 20 s |
| 4 | Server integration | `packages/server/test/integration/**` | vitest 5 (project `server-int`) | `node` | real `bloomberg_test` | replay store | ≈ 400 | < 180 s |
| 5 | Replay / parity | `packages/server/test/replay/**`, `packages/server/test/parity/**` | vitest 5 (project `server-int`) | `node` | real `bloomberg_test` | replay store | ≈ 90 | < 120 s |
| 6 | Fuzz (QA-05) | `packages/core/test/**/*.fuzz.test.ts`, `packages/server/test/fuzz/**` | vitest 5 (projects `core`, `server-unit`) | `node` | none | none | 13 targets | < 90 s |
| 7 | Component | `packages/web/test/**` | vitest 5 (project `web`) | `jsdom` + React Testing Library | none | mocked SDK | ≈ 260 | < 90 s |
| 8 | End-to-end | `packages/e2e/tests/**` | `@playwright/test` 1.63 | Google Chrome (`channel: 'chrome'`) | real `bloomberg_test` | replay store | 12 specs | < 240 s |
| 9 | Budget / bench | `*.bench.ts`, `packages/server/test/perf/**` | vitest bench + Playwright perf spec | mixed | seeded | replay store | 9 budgets | < 120 s |

Layers 1–7 are `npm test`. Layer 8 is `npm run e2e`. Layer 9 runs in both (`bench` in CI, perf specs in
the e2e job) and is reported, with only the thresholds in §15 failing the build.

### 1.1 Why the shape is this way

The fat base is `packages/core`, which by construction has no IO (`tsconfig.json` with
`lib: ["ES2022"]`, no `"DOM"`, no `@types/node` — ARCHITECTURE §3.1). Every analytic, day count,
calendar, identifier codec, command parser, ranking function, formatter and CSV writer is testable with
no fixtures, no database and no clock. The expensive layers exist only for behaviour that genuinely
crosses a boundary: SQL semantics (bitemporal exclusion constraints, RLS, partition pruning), the
WebSocket state machine, and the browser.

---

## 2. Runner configuration

### 2.1 vitest 5 projects — `vitest.config.ts` (repo root)

One root config declares the projects; each package keeps its own `vitest.config.ts` so a package can be
run alone. **Addition required** — no config file is named in CONTRACTS.md.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',                 // packages/core/vitest.config.ts
      'packages/sdk',
      'packages/server',               // declares two projects: server-unit, server-int
      'packages/web',
    ],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './reports/vitest-junit.xml' },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      exclude: ['**/*.d.ts', '**/manifests/index.ts', '**/jobs/index.ts', '**/screens/index.ts',
                '**/functions/index.ts', 'packages/*/test/**', 'fixtures/**', 'scripts/**'],
      thresholds: { /* §6.3 */ },
    },
  },
});
```

| Project | `environment` | `setupFiles` | `globalSetup` | `pool` | `testTimeout` |
| --- | --- | --- | --- | --- | --- |
| `core` | `node` | — | — | `threads` (default) | 5 000 ms (fuzz files override to 60 000) |
| `sdk` | `node` | `packages/sdk/test/setup.ts` (fake `WebSocket`, `crypto.randomUUID` stub) | — | `threads` | 5 000 ms |
| `server-unit` | `node` | `packages/server/test/setup.unit.ts` (env: `PROVIDER_MODE=replay`) | — | `threads` | 10 000 ms |
| `server-int` | `node` | `packages/server/test/setup.int.ts` (pool, harness, `VirtualClock`) | `packages/server/test/globalSetup.ts` (§4.2) | `forks`, `singleFork: false`, `maxForks: 4` | 30 000 ms |
| `web` | `jsdom` | `packages/web/test/setup.tsx` (RTL `cleanup`, `matchMedia`, `ResizeObserver`, `requestAnimationFrame` shim with a manual frame pump) | — | `threads` | 10 000 ms |

`server-int` uses `forks`, not `threads`: the `pg` pool, the advisory-lock leader election
(`ingest/lock.ts`) and the batched `entitlements/accessLog.ts` writer all keep process-level state, and
fork isolation is what lets four integration files run concurrently against one database without a
shared connection.

### 2.2 jsdom + React Testing Library (`web`)

- `@testing-library/react` 16 with React 19 (`ReactDOM.createRoot`), `@testing-library/user-event` for
  keyboard input. Both are **additions required** (not in the pinned dependency list).
- Queries are role-first (`getByRole('grid')`, `getByRole('row')`, `getByRole('columnheader')`); a test
  that needs `data-testid` is a signal the widget is not accessible and fails
  `packages/web/test/screen/renderer.test.tsx`'s keyboard-operability assertion (TERM-08).
- jsdom does not lay out or animate. `packages/web/test/setup.tsx` installs a **manual frame pump**:
  `requestAnimationFrame` queues callbacks, `flushFrames(n)` runs them and records the synchronous
  duration of each via `performance.now()`. That is the only timing source for
  `packages/web/test/grid.frame-budget.test.ts` and `packages/web/test/autocomplete.frame.test.tsx`;
  no `setTimeout`-based waiting appears in a web test.
- `animationend` does not fire in jsdom, so the flash classes are removed by an explicit
  `cellRegistry.endFlash()` in the test, and the 700 ms lifetime is asserted in Playwright instead
  (`packages/e2e/tests/live-grid.spec.ts`).
- The SDK is not mocked wholesale. `packages/web/test/harness/liveClient.ts` (**addition required**)
  builds a real `LiveClient` over an in-memory duplex that accepts the exact `ServerMsg` frames from
  `packages/sdk/src/wire/ws.ts`, so component tests exercise the real decode → `QuoteCache` →
  `cellRegistry` path (ARCHITECTURE §6.6).

### 2.3 Playwright — `packages/e2e/playwright.config.ts`

```ts
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,                       // one seeded database, one server process
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: '../../reports/e2e-junit.xml' }]],
  use: {
    channel: 'chrome',                        // installed Google Chrome, not bundled Chromium
    baseURL: 'http://localhost:5173',
    viewport: { width: 1600, height: 1000 },  // four panels at terminal density
    trace: 'retain-on-failure', video: 'retain-on-failure', screenshot: 'only-on-failure',
    timezoneId: 'America/New_York',           // every ET/UTC assertion in the screens depends on it
    locale: 'en-US',
  },
  webServer: [
    { command: 'npm -w @terminal/server run start:test', url: 'http://localhost:8080/health', reuseExistingServer: !process.env.CI },
    { command: 'npm -w @terminal/web run dev -- --port 5173',  url: 'http://localhost:5173',   reuseExistingServer: !process.env.CI },
  ],
});
```

`packages/e2e/fixtures/serverProcess.ts` (named in ARCHITECTURE §3.5) spawns the server with
`PROVIDER_MODE=replay`, `DATABASE_URL=postgres://…/bloomberg_test`, `SIM_FEED=1`,
`CONFLATION_MS_DEFAULT=100` and a fixed `SESSION_SECRET`, and exposes `restartServer()` and
`killSocket()` helpers used by the resync spec.

---

## 3. What each layer may and may not do

| Rule | Enforced by |
| --- | --- |
| `packages/core` performs no IO and imports no Node builtin | `packages/core/test/no-io.test.ts` (**addition required**) — walks `src/**` and fails on `node:`/`fs`/`http` imports; the tsconfig makes it a compile error too |
| `packages/web` never fetches directly and never does arithmetic on prices | `packages/web/test/no-direct-io.test.ts` (named in ARCHITECTURE §3.2); `packages/web/test/format/no-arithmetic.test.ts` (**addition required**) |
| No data service is reachable without an entitlement decision | `packages/server/test/unit/entitlement.guard.test.ts` (ARCHITECTURE §10) — instantiates every service in `server/src/data/` with a throwing evaluator stub and asserts every public method throws |
| No network under replay | `packages/server/test/replay/no-network.test.ts` (PROVIDERS §3.6) |
| Drizzle mirror equals the committed SQL | `packages/server/test/integration/schema.mirror.test.ts` |

---

## 4. The Postgres harness

### 4.1 Databases and extensions

`bloomberg_test` is a real Postgres 14 database, created once per machine:

```sql
CREATE DATABASE bloomberg_test;
\c bloomberg_test
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- autocomplete trigram indexes
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- bitemporal EXCLUDE constraints
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- user_credentials.secret_hash, sessions.token_hash
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

There is no TimescaleDB and no pgvector; `bars_daily`, `bars_intraday`, `quote_ticks`,
`option_quotes`, `access_log` and `usage_events` are declaratively range-partitioned
(DATA_MODEL §7.1), so partition-pruning behaviour is a real thing to test, not a vendor feature.

`TEST_DATABASE_URL` selects the database (**addition required**: `config.ts` names only `DATABASE_URL`;
the test harness reads `TEST_DATABASE_URL ?? DATABASE_URL` and refuses to run if the resolved database
name is not `bloomberg_test`, so a mis-set env can never truncate `bloomberg_dev`).

### 4.2 Migrations and seed — `packages/server/test/globalSetup.ts`

Runs once per vitest invocation, before any `server-int` file:

1. Connect as the owner; assert `current_database() = 'bloomberg_test'`.
2. Read `schema_meta` where `key = 'migration'`. If the stored value equals
   `sha256(concat of packages/server/drizzle/migrations/*.sql, sorted by name)`, skip to step 5.
3. Otherwise `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`, re-create the four extensions, then
   apply every `packages/server/drizzle/migrations/NNNN_<name>.sql` in name order with drizzle-orm's
   migrator (the same code path `npm run db:migrate` uses — CI never has a second migration mechanism).
4. `ensurePartitions()` for the fixture date range (2020-01-01 … today + 1 month) via
   `server/src/db/partitions.ts`, then write the new hash into `schema_meta`.
5. Run the seed (`server/src/seed/index.ts`, modules 1–13 of DATA_MODEL §18) with
   `PROVIDER_MODE=replay`. The seed is deterministic and idempotent, so a warm database re-runs it as a
   no-op in a few seconds and a cold one takes ≈ 40 s.
6. Snapshot the seeded row counts into `globalThis.__SEED_COUNTS__` so
   `packages/server/test/integration/seed.test.ts` can assert the volumes in DATA_MODEL §18
   (33 licence sources, ≈ 36 k instruments, 503 index members, 3 510 option contracts, 7 users,
   2 firms) and fail loudly when a fixture changes shape.

In CI the step is identical — there is no "CI-only schema". The job runs
`npm run db:test:reset` (drop + migrate + seed) once, then `npm test`; the hash check in step 2 makes
the local developer loop skip all of it.

### 4.3 Per-test transaction rollback — `packages/server/src/test/db.ts`

The default harness. One checked-out `pg` client per test, `BEGIN` before the test body, `ROLLBACK`
after it, with drizzle bound to that single client so every repository, service and route handler in the
test sees the same open transaction:

```ts
// packages/server/src/test/db.ts  (path named in ARCHITECTURE §3.3)
export interface TestDb { db: Db; client: PoolClient; savepoint<T>(fn: () => Promise<T>): Promise<T> }
export function withTxDb(): TestDb;          // beforeEach BEGIN … afterEach ROLLBACK  (default)
export function withCleanDb(tables: string[]): TestDb;   // ADDITION REQUIRED — §4.4
export function asUser(t: TestDb, userId: number, firmId: number, role?: string): Promise<void>;
```

Mechanics that matter:

- `withTx(fn)` in `server/src/db/client.ts` must issue `SAVEPOINT`/`RELEASE` rather than
  `BEGIN`/`COMMIT` when it detects it is already inside a transaction, otherwise nested service calls
  would commit through the harness. `packages/server/test/integration/txnesting.test.ts` asserts that a
  service which rolls back an inner `withTx` leaves the outer test transaction usable.
- `asUser()` issues `SET LOCAL app.user_id`, `SET LOCAL app.firm_id` and, for RLS tests,
  `SET LOCAL ROLE terminal_app` (migration 0015), all of which are transaction-scoped and therefore
  undone by the rollback. `packages/server/test/integration/functions/W.rls.test.ts` and
  `packages/server/test/integration/rls.isolation.test.ts` use it to prove `Other Desk` cannot read
  `Demo Capital` watchlists, portfolios or rooms.
- Sequences are **not** rolled back. No test asserts a literal `bigserial` value; ids are always read
  back from the insert.
- Tests run concurrently in four forks against one database. Rollback keeps them from seeing each
  other's writes, but seeded rows are shared and must be treated as read-only; a test that needs to
  mutate a seeded row inserts its own instrument instead.

### 4.4 When rollback is the wrong harness

Three things cross the test transaction and need `withCleanDb(tables)`, which instead truncates the
named tables (plus their partitions) in `beforeEach` and lets writes commit:

| Case | Why | Test |
| --- | --- | --- |
| `access_log` assertions | `entitlements/accessLog.ts` buffers in a ring and bulk-inserts on its own pool connection every 1 s / 5 000 rows, which cannot see an uncommitted transaction | `packages/server/test/integration/entitlements/accessLog.test.ts` |
| Partition maintenance | `db/partitions.ts` runs DDL (`CREATE TABLE … PARTITION OF`) that is legal but pointless to roll back, and `dropExpired` must be observed | `packages/server/test/integration/partitions.test.ts` |
| Leader election | `pg_try_advisory_lock` is session-scoped and needs two real connections | `packages/server/test/integration/ingest/lock.test.ts` |

The harness exposes `flushAccessLog()` and `flushUsageEvents()` so those tests never sleep.

---

## 5. npm scripts

Root `package.json` (npm workspaces). Scripts already named in the design spine are marked ✔; the rest
are **additions required**.

| Script | Runs | Notes |
| --- | --- | --- |
| `npm test` ✔ | `vitest run` at the root (projects `core`, `sdk`, `server-unit`, `server-int`, `web`) | must pass offline; `PROVIDER_MODE=replay` is forced by the setup files |
| `npm run test:watch` | `vitest` | |
| `npm run test:core` | `vitest run --project core` | no DB needed |
| `npm run test:sdk` | `vitest run --project sdk` | |
| `npm run test:unit` | `vitest run --project core --project sdk --project server-unit` | the "no database" subset; < 60 s |
| `npm run test:server` | `vitest run --project server-unit --project server-int` | |
| `npm run test:integration` | `vitest run --project server-int --dir packages/server/test/integration` | |
| `npm run test:replay` | `vitest run --project server-int --dir packages/server/test/replay` | QA-02 |
| `npm run test:parity` | `vitest run --project server-int --dir packages/server/test/parity` | API-05 |
| `npm run test:fuzz` | `vitest run --project core --project server-unit -t fuzz` with `FUZZ_ITERATIONS=100000` | QA-05; CI uses the default 10 000 |
| `npm run test:web` | `vitest run --project web` | jsdom |
| `npm run bench` | `vitest bench --project core` | §15 |
| `npm run coverage` | `vitest run --coverage` | thresholds in §6.3 |
| `npm run e2e` ✔ | `playwright test -c packages/e2e/playwright.config.ts` | |
| `npm run e2e:ui` | `playwright test --ui` | |
| `npm run test:live` ✔ | `PROVIDER_MODE=live vitest run --project server-int --dir packages/server/test/live` | never in CI; the only network suite |
| `npm run db:migrate` ✔ | drizzle migrator against `DATABASE_URL` | |
| `npm run db:seed` ✔ | `server/src/seed/index.ts` | offline, from the replay store |
| `npm run db:test:reset` | drop schema → `db:migrate` → `db:seed` against `TEST_DATABASE_URL` | CI step 3 |
| `npm run fixtures:import` ✔ | `scripts/fixtures-import.ts` | idempotent; CI asserts a clean `git diff` afterwards |
| `npm run fixtures:record` ✔ | `PROVIDER_MODE=record` | developer-only |
| `npm run replay:run` ✔ | `server/src/replay/cli.ts run --session <name>` | |
| `npm run replay:diff` ✔ | `server/src/replay/cli.ts diff <a> <b>` | |
| `npm run golden:functions` ✔ | regenerates `fixtures/golden/functions/**` payload goldens | reviewable diff |
| `npm run golden:update` | regenerates `fixtures/golden/analytics/**` | §7.1; refuses to run unless `ALLOW_GOLDEN_UPDATE=1` |
| `npm run gen:functions` ✔ | regenerates the manifest/screen/resolver barrels | CI asserts a clean `git diff` |
| `npm run typecheck` | `tsc -b --noEmit` across the workspace | |
| `npm run lint` | eslint + prettier check | |

---

## 6. CI

### 6.1 Order

```
1  setup            node 22, npm ci, Postgres 14 service with pg_trgm/btree_gist/pgcrypto/uuid-ossp
2  static           npm run lint && npm run typecheck
3  generated        npm run gen:functions && npm run fixtures:import && git diff --exit-code
4  database         npm run db:test:reset                       (migrate + seed, ≈ 60 s)
5  unit             npm run test:unit                           (fails fast; no DB)
6  integration      npm test -- --coverage                      (all five projects incl. web)
7  replay+parity    included in 6; reported separately from the JUnit file
8  bench            npm run bench                               (thresholds in §15)
9  e2e              npx playwright install chrome --with-deps && npm run e2e
10 artefacts        reports/vitest-junit.xml, reports/e2e-junit.xml, coverage/lcov.info, playwright-report/
```

Steps 2, 3 and 5 are the fast gate (< 3 minutes). Step 6 is the long pole. Steps 8 and 9 do not run on
draft pull requests.

### 6.2 Release gate (QA-02)

Before a release tag, `npm run replay:run` is executed for every committed session in
`fixtures/sessions/` against the candidate, and `npm run replay:diff` compares each state log with the
previous release's. Any divergence outside `ts.cap`/`ts.pub` blocks the release until it is explained in
the release notes; an accepted change is committed as a new `expected.ndjson` in the same pull request.

### 6.3 Coverage thresholds

Per project, lines / branches, enforced by `vitest --coverage`:

| Project | Lines | Branches | Rationale |
| --- | --- | --- | --- |
| `core` | 95 % | 90 % | pure, no excuses; the analytics and parsers live here |
| `sdk` | 90 % | 85 % | wire schemas and the quote cache |
| `server` (unit + int combined) | 85 % | 78 % | excludes `seed/**` (exercised wholesale by globalSetup) and `providers/*/adapter.ts` fetch builders (exercised by replay) |
| `web` | 80 % | 72 % | canvas renderer internals are covered by e2e pixel-free assertions instead |

Uncovered-by-design directories are listed in the `coverage.exclude` array, not silently ignored: the
generated barrels (`manifests/index.ts`, `jobs/index.ts`, `screens/index.ts`, `functions/index.ts`),
`scripts/**` and `fixtures/**`.

---

## 7. Golden analytics datasets (QA-01, ANAL-09)

### 7.1 Layout, record shape, tolerance semantics

```
fixtures/golden/analytics/
  options/bsm.json            §7.2
  bond/price.json             §7.3
  bond/accrued.json           §7.4
  bond/solver.json            §7.5
  bill/discount.json          §7.6
  curve/bootstrap.json        §7.7
  stats/returns.json          §7.8
  adjust/aapl.json            §7.9 (named in DATA_MODEL §6.1)
  adjust/split-dividend.json  §7.9
  pit/fundamentals.json       §7.10
```

Every file is an array of cases with this shape (**addition required** — the directory is named in
ARCHITECTURE §3.2, the record is not):

```ts
export interface GoldenCase {
  id: string;                      // stable, referenced by name in test output: 'bsm.atm.1y'
  engine: string;                  // 'bsm' | 'bond.price' | 'curve.bootstrap' | …  (EngineResult.engine.name)
  engineVersion: string;           // pinned; a version bump must update or explicitly re-bless the case
  inputs: Record<string, unknown>; // exactly the engine's declared input set (ANAL-08)
  valuationTs: string;             // ISO 8601; VirtualClock is set to it
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;     // per output key; absolute unless the key is listed in relTol
  relTol?: Record<string, number>;
  source: string;                  // where the expected value comes from: closed form, published text, or 'derived: <case id>'
}
```

Tolerance rules: **absolute by default**, on the stated unit. A "closed form" case (BSM, par-bond
round trips, day-count fractions) gets `1e-9`–`1e-12` because the only error is double-precision
rounding. An iterative case (root find, bootstrap) gets the solver's own convergence criterion. A
cross-check against a second method (tree, Monte Carlo, numerical derivative) gets a tolerance stated
with its reason, never "whatever passes today".

`packages/core/test/analytics/golden.test.ts` (**addition required**) is the single driver: it loads
every file, dispatches on `engine`, runs the named engine through `defineEngine` and asserts each
`expected` key within `tol`. It additionally asserts `EngineResult.inputsHash` is stable across two runs
and that `engine.version` matches `engineVersion` (ANAL-08).

### 7.2 Black–Scholes–Merton (ANAL-03) — `packages/core/test/analytics/bsm.test.ts`

**Case `bsm.atm.1y`.** Inputs: `S = 100`, `K = 100`, `r = 0.05` continuous, `q = 0`, `sigma = 0.20`,
`T = 1.0` year, `valuationTs = 2026-01-02T00:00:00Z`.

Intermediates the test also pins: `d1 = 0.35`, `d2 = 0.15`, `N(d1) = 0.6368306512`,
`N(d2) = 0.5596176923`, `e^{-rT} = 0.9512294245`, `phi(d1) = 0.3752403`.

| Output | Expected | Unit | Tolerance |
| --- | --- | --- | --- |
| `call` | **10.450584** | price | `1e-6` |
| `put` | **5.573526** | price | `1e-6` |
| `d1` | 0.35 | — | `1e-12` |
| `d2` | 0.15 | — | `1e-12` |
| `deltaCall` | **0.636831** | per 1.00 of S | `1e-6` |
| `deltaPut` | **−0.363169** | per 1.00 of S | `1e-6` |
| `gamma` | **0.018762** | per 1.00 of S, per 1.00 of S | `1e-6` |
| `vega` | **37.524035** (= **0.375240** per vol point) | per 1.00 of sigma | `1e-6` |
| `thetaCall` | **−6.414028** per year (= −0.017573 per calendar day) | price/year | `1e-6` |
| `thetaPut` | **−1.657881** per year | price/year | `1e-6` |
| `rhoCall` | **53.232481** (= **0.532325** per 100 bp) | per 1.00 of r | `1e-6` |
| `rhoPut` | **−41.890460** | per 1.00 of r | `1e-6` |

Assertions layered on top of the table:

1. **Put–call parity.** `call − put − (S·e^{−qT} − K·e^{−rT})` must be `0` within `1e-12`;
   `S·e^{−qT} − K·e^{−rT} = 4.8770575499`.
2. **Delta signs and bound.** `0 < deltaCall < 1`; `−1 < deltaPut < 0`; `deltaCall − deltaPut = 1`
   exactly when `q = 0` (tolerance `1e-12`).
3. **Gamma sign, symmetry and magnitude.** `gamma > 0`; gamma is identical for the call and the put
   (`1e-15`); and `gamma < 1 / (S·sigma·sqrt(2·pi·T)) = 0.0199471`, the analytic maximum at `d1 = 0`.
   The computed `0.018762` sits just under it, which is the expected shape for a near-ATM option.
4. **Vega sign, symmetry and magnitude.** `vega > 0`; identical for call and put (`1e-15`); and
   `vega < S·sqrt(T/(2·pi)) = 39.894228`, its maximum over sigma.
5. **Theta and rho signs.** `thetaCall < thetaPut < 0` for this case; `rhoCall > 0 > rhoPut`; and
   `rhoCall − rhoPut = K·T·e^{−rT} = 95.122942` within `1e-6`.
6. **Numerical-derivative cross-check (ANAL-09, independent method).** Central differences on the
   analytic price: `delta` with `h = 1e-4` on S, `gamma` with `h = 0.01` on S (second difference),
   `vega` with `h = 1e-5` on sigma, `rho` with `h = 1e-6` on r — each within `1e-6` of the closed-form
   greek. The second-order truncation error is far below that, so the tolerance is really a guard
   against a sign or scaling slip.
7. **Implied vol round trip (`options/bsm.ts#impliedVol`, Brent + Newton).** The round trip must be fed
   the engine's **own unrounded** output, not the rounded price pinned in the table above: the exact call
   is `10.4505835722`, and feeding the table's rounded `10.450584` back returns `sigma = 0.2000000114`,
   i.e. 1.14e-8 off — vega is 37.524 per unit vol, so the 4.3e-7 of price rounding becomes 1.1e-8 of vol
   and a `1e-8` tolerance is unsatisfiable by a correct implementation. So: `impliedVol(bsm(sigma=0.20))`
   returns `sigma = 0.20` within `1e-8` in ≤ 12 iterations, and the same for the put (`5.5735260223`;
   the put branch would in fact pass from the rounded price, at 5.9e-10, but the assertion is written the
   same way for both). A round trip that must start from a pinned literal uses tolerance `1e-7`. A price below the intrinsic bound (`call = 4.0`, intrinsic `= 4.877058`) returns
   `null` with `reason: 'NO_ARBITRAGE_BOUND'`, it does not throw and does not return a negative vol.
8. **Two independent implementations (ANAL-09)** — `packages/core/test/analytics/bsm.crosscheck.test.ts`:
   - CRR binomial (`options/tree.ts`, 5 000 steps, European) reproduces `call = 10.450584` within
     `5e-3` (CRR converges O(1/n) with parity oscillation; this bound is the oscillation envelope at
     n = 5 000, not a fudge factor);
   - seeded Monte Carlo (`options/mc.ts`, 1 000 000 antithetic paths, control variate on `S_T`,
     `seed = 20260102`) reproduces it within `2e-2` (≈ 3 standard errors) and, because the PRNG is
     seeded, gives the identical number on every run and every machine.

**Case `bsm.deep.itm.call`** (guards the tails): `S = 100, K = 50, r = 0.05, q = 0, sigma = 0.20,
T = 1` → `deltaCall > 0.999`, `gamma < 1e-4`, `call − (S − K·e^{−rT}) ≥ 0` (never below intrinsic),
`vega > 0`. **Case `bsm.zero.vol`**: `sigma = 0` → `call = max(S·e^{−qT} − K·e^{−rT}, 0) = 4.877058`
(tolerance `1e-9`), `gamma = 0`, `vega = 0`, and no NaN anywhere. **Case `bsm.expiry`**: `T = 0` →
payoff exactly, greeks `0` except delta ∈ {0, 1}.

### 7.3 Bond price ↔ yield (ANAL-01) — `packages/core/test/analytics/bond.price.test.ts`, `bond.risk.test.ts`

Street convention: semiannual compounding, ACT/ACT ICMA accrual, settlement on a coupon date so that
accrued is zero and the case isolates the discounting.

**Case `bond.par.roundtrip`.** A 10-year note, coupon **4.250 %** semiannual, dated and settling on
**2026-08-15**, maturing **2036-08-15**, price **100.000000** clean per 100 face.

- `yieldFromPrice(100.000000)` → **4.250000 %**, tolerance `1e-10` (percent). This is the definitional
  par identity: on a coupon date, price = 100 ⇔ yield = coupon.
- `priceFromYield(4.250000 %)` → **100.000000**, tolerance `1e-10`.
- Round trip `priceFromYield(yieldFromPrice(p))` for `p ∈ {95, 98.5, 100, 101.25, 110}` returns `p`
  within `1e-10`.
- `accrued = 0.000000` exactly on the coupon date.

**Case `bond.discount.2y`** (the fully hand-checkable discount bond). Coupon **5.000 %** semiannual,
**4 remaining periods** (2 years), settlement on a coupon date, yield **6.000 %**.

Arithmetic, stated so the expected value can be audited without running anything:
`v = 1/1.03`; `v² = 0.942595909`, `v³ = 0.915141659`, `v⁴ = 0.888487048`;
annuity `= (1 − v⁴)/0.03 = 3.71709839`;
price `= 2.5 × 3.71709839 + 100 × 0.888487048`.

| Output | Expected | Tolerance |
| --- | --- | --- |
| `cleanPrice` | **98.141451** (98.1414508 per 100) | `1e-6` |
| `yieldFromPrice(98.141451)` | **6.000000 %** | `1e-9` |
| `macaulayDuration` | **1.927236** years | `1e-6` |
| `modifiedDuration` | **1.871103** (= Macaulay / 1.03) | `1e-6` |
| `dv01` | **0.018363** per 100 face per bp | `1e-6` |
| `convexity` | **4.484914** (second derivative w.r.t. the semiannual-bond-basis annual yield, divided by price) | `1e-6` |

Cross-checks in `bond.risk.test.ts`: DV01 from the analytic modified duration equals the central
difference `(P(y − 1bp) − P(y + 1bp)) / 2` within `5e-9` (the truncation error is O(h²·P‴) ≈ 1e-10);
convexity equals the second central difference with `h = 1 bp` within `1e-5`; the sum of key-rate
durations (2y node only, here) equals the modified duration within `1e-9`.

**Case `bond.premium.short`**: coupon 5 %, yield 4 %, 4 periods → `price = 101.903864`
(`2.5 × (1 − 1.02⁻⁴)/0.02 + 100 × 1.02⁻⁴`, exactly `101.903864349…`: `1.02⁻⁴ = 0.923845426`, annuity
`3.807728710`, `9.519321774 + 92.384542576`), tolerance `1e-6`, asserting price > 100 ⇔ yield < coupon.
(The earlier `101.905126` in this case was arithmetically wrong by 1.26e-3 — more than 1 000 tolerances —
and would have been "fixed" by bending the engine to match it.)

### 7.4 Accrued interest across day counts (ANAL-01) — `packages/core/test/analytics/daycount.test.ts`

**One stated coupon period, five conventions.** Face 100, annual coupon rate **5.000 %**, semiannual
frequency. Previous coupon **2026-02-15**, next coupon **2026-08-15**, settlement **2026-05-31**. 2026
is not a leap year. Actual days from 2026-02-15 to 2026-05-31 = **105** (day-of-year 151 − 46); actual
days in the coupon period = **181** (227 − 46).

| Convention (`daycount/conventions.ts`) | Day count numerator / denominator | Year fraction | **Accrued per 100** | Tolerance |
| --- | --- | --- | --- | --- |
| `ACT_360` | 105 / 360 | 0.291666667 | **1.458333333** | `1e-9` |
| `ACT_ACT_ISDA` | 105 / 365 (both dates in a non-leap year, no year split) | 0.287671233 | **1.438356164** | `1e-9` |
| `THIRTY_360_US` | 106 / 360 — D1 day 15 is neither 30 nor 31, so the D2 = 31 → 30 rule does **not** fire: `30×(5−2) + (31−15) = 106` | 0.294444444 | **1.472222222** | `1e-9` |
| `THIRTY_E_360` | 105 / 360 — D2 = 31 → 30 unconditionally: `90 + (30−15) = 105` | 0.291666667 | **1.458333333** | `1e-9` |
| `ACT_ACT_ICMA(2)` | 105 / 181 of a 2.5 coupon | 0.290055249 (× 2 periods/yr) | **1.450276243** | `1e-9` |

The test asserts all five values and that `THIRTY_360_US ≠ THIRTY_E_360` for this date pair — the whole
point of choosing a settlement on the 31st. It also asserts the ISDA year-split branch with a second
case (`2026-11-15 → 2027-02-15`: `46/365 + 46/365`… computed as `46/365 + 46/365` with the 2026 and
2027 splits, expected year fraction `0.252054795`, tolerance `1e-9`) and the leap-year branch
(`2028-02-15 → 2028-05-31`, 106 actual days, `ACT_ACT_ISDA = 106/366 = 0.289617486`).

Treasury note accrual (`govt_terms.day_count = 'ACT/ACT'`) uses `ACT_ACT_ICMA(freq)`, and
`packages/server/test/integration/functions/YAS.golden.test.ts` asserts the seeded on-the-run 10-year
reproduces the same accrued through the full resolver path.

### 7.5 Yield solver: Newton convergence and the bisection fallback — `packages/core/test/analytics/bond.solver.test.ts`

The solver is Newton with a bracket guard over `[yLo, yHi] = [−0.99, 10.0]` (−99 % to 1000 %), falling
back to bisection whenever a Newton iterate leaves the bracket, produces a non-finite price, or fails to
reduce `|f|`. `EngineResult.outputs.method` records which path ran — that is what the tests assert on.

| Case | Input | Expected | Tolerance |
| --- | --- | --- | --- |
| `solver.newton` | `bond.discount.2y` cashflows, target clean price **98.141451**, `y0 = 0.05` (the coupon) | `y = 0.060000000000`, `method = 'newton'`, `iterations ≤ 4`, final `|Δy| < 1e-12` | `1e-12` |
| `solver.bisection` | identical cashflows and target, but `y0 = 9.5` | first Newton step is `y1 = y0 − f/f' ≈ −1111.4` — outside the bracket — so the guard fires: `y = 0.060000000000`, `method = 'bisection'`, `iterations ≤ 60`, `|f(y)| < 1e-10` | `1e-10` |
| `solver.noRoot` | identical cashflows, target clean price **0.005** | `f` has no sign change on the bracket (`P(10.0) = 0.576774 > 0.005`), so the engine returns `{ ok: false, reason: 'NO_ROOT_IN_BRACKET' }` — it does not diverge, does not return `NaN`, and does not throw | — |
| `solver.determinism` | `solver.newton` run twice | identical `y` bit-for-bit and identical `inputsHash` (ANAL-08) | exact |

The two convergent cases must agree with each other to `1e-10`: the same root reached by two different
methods is the cheapest independent implementation check available (ANAL-09).

### 7.6 Treasury bill (ANAL-01) — `packages/core/test/analytics/bill.test.ts`

**Case `bill.13wk`.** 13-week bill, **91 days** to maturity, discount rate **4.000 %**, face 100.

- `priceFromDiscount = 100 × (1 − 0.04 × 91/360)` → **98.988889** (98.98888889), tolerance `1e-6`.
- `discountFromPrice(98.988889)` → **4.000000 %**, tolerance `1e-9` (exact inverse).
- `investmentYield` (coupon-equivalent, ≤ 182 days: `((100 − P)/P) × 365/t`) → **4.096981 %**,
  tolerance `1e-6`.
- Invariant: `investmentYield > discountRate` for every case in the file, and the > 182-day branch is
  exercised by `bill.52wk` (364 days, discount 4.25 %) using the quadratic formula, asserted against a
  numerical solve of the same definition within `1e-9`.

### 7.7 Curve bootstrap (ANAL-02) — `packages/core/test/analytics/curve.bootstrap.test.ts`

**Case `curve.par.selfconsistency` — the round-trip requirement.** Inputs: a `UST_PAR` curve
(`curves.kind = 'par'`, `day_count = 'ACT/ACT'`, `compounding = 'semiannual'`,
`default_interpolation = 'log_linear_df'`) with par yields

`{ 1Y: 4.00, 2Y: 4.20, 3Y: 4.35, 5Y: 4.55, 7Y: 4.70, 10Y: 4.85 }` (percent), `curveDate = 2026-09-15`.

Assertion: for **every input tenor**, repricing the par bond that defines it with the bootstrapped
discount factors gives a clean price of **100.000000000000** and a re-implied par rate equal to the
input, `|Δ| ≤ 1e-10` (percent). This is the defining property of a bootstrap and it is checked at every
node, not just the last. Additional invariants on the same case: `df(0) = 1` exactly;
`df` strictly decreasing; `zero(t)` and `fwd(t1,t2)` mutually consistent
(`df(t2)/df(t1) = exp(−fwd·(t2−t1))` for the continuous accessor, `1e-12`); the number of nodes equals
the number of inputs; `inputsHash` is stable across two builds and changes when any input changes
(ANAL-08).

**Case `curve.flat.analytic` — a closed-form anchor.** A flat **5.000 %** par curve at every tenor
1Y…10Y must produce a flat zero curve at 5.000 % (semiannual bond basis) and

| Output | Expected (closed form) | Tolerance |
| --- | --- | --- |
| `df(0.5)` | `1.025⁻¹` = 0.975609756 | `1e-12` |
| `df(1)` | `1.025⁻²` = 0.951814396 | `1e-12` |
| `df(2)` | `1.025⁻⁴` = 0.905950645 | `1e-12` |
| `df(10)` | `1.025⁻²⁰` = 0.610270940 | `1e-12` |
| `zero(t)` for all t | 5.000000 % | `1e-10` |

**Case `curve.interpolation.monotone`**: the same inputs under `monotone_convex` and `linear_zero`
must still reprice every input to `1e-10` — interpolation may change values *between* nodes, never *at*
them. The three interpolators are asserted to differ at `t = 4` (a non-node point) by more than
`1e-6`, so a silently mis-wired interpolation cannot pass.

**Case `curve.ois.bootstrap`**: SOFR OIS from seeded fixings + par OIS rates; same round-trip property,
`1e-10`, ACT/360 with daily compounding. The fixture-backed version of all of this is
`packages/server/test/integration/curves.build.test.ts`, which bootstraps from the recorded
`treasury-xml2` par yields and `nyfed-sofr` fixings and asserts the same reprice-to-input property plus
a `curve_builds` row whose `inputs_hash` matches a second identical build.

### 7.8 Volatility and Sharpe on a fixed series (ANAL-07) — `packages/core/test/analytics/stats.test.ts`

**Case `stats.vol.sharpe.10`.** A fixed series of **10 daily simple returns**, in percent:

```
+1.00, −0.50, +0.75, +0.25, −1.25, +2.00, −0.75, +0.50, +1.50, −1.00
```

Conventions (`stats/index.ts` exports a `Conventions` object and echoes it in the outputs — ANAL-07;
the test asserts the echoed object too): simple (not log) returns; **sample** standard deviation with
`n − 1 = 9` degrees of freedom; **252** trading days per year; volatility annualised by `×√252`; mean
annualised by `×252` (arithmetic, not geometric); excess return `= mean − rf/252` with a **2.000 %**
annual simple risk-free rate.

The arithmetic, stated in full:

- `Σr = 2.50 %`, `mean = 0.25 %` per day.
- deviations: `0.75, −0.75, 0.50, 0.00, −1.50, 1.75, −1.00, 0.25, 1.25, −1.25`;
  `Σd² = 10.875 %²`; sample variance `= 10.875/9 = 1.208333333 %²`.
- daily σ `= √1.208333333 = 1.099242 %`.
- `√252 = 15.874507866`.
- annualised mean `= 0.25 % × 252 = 63.00 %`; `rf = 2.00 %`; annualised excess `= 61.00 %` exactly.

| Output | Expected | Tolerance |
| --- | --- | --- |
| `meanDaily` | **0.250000 %** | `1e-12` |
| `stdevDaily` (n−1) | **1.099242 %** | `1e-6` (percent) |
| `volAnnualised` | **17.449928 %** | `1e-6` (percent) |
| `returnAnnualised` | **63.000000 %** | `1e-12` |
| `excessAnnualised` | **61.000000 %** | `1e-12` |
| `sharpe` | **3.495716** | `1e-6` |
| `maxDrawdown` (compounded on the same series) | **−1.250000 %** (the single 2026-01-05 return; no consecutive negatives compound deeper) | `1e-9` |

Companion assertions: a population (`n`) stdev on the same series is `1.042833 %`
(`√(10.875/10) = √1.0875`) and the engine must **not** return it unless
`Conventions.ddof = 0` is passed — a silent ddof change is the classic vol bug, so the test pins both
branches. Sortino, information ratio and beta use the same series against a fixed benchmark series in
`stats.beta.10`, with OLS beta asserted against the closed form `cov/var` within `1e-12`.

### 7.9 Corporate-action adjustment (REF-09) — `packages/core/test/adjust/corporateActions.test.ts`

Stored bars are always unadjusted; factors are computed on read and apply to bars **strictly before**
the ex-date, cumulatively from latest to earliest (DATA_MODEL §6.1).

**Case `adjust.split.dividend`.** One instrument, two actions:

| Action | `ca_type` | `status` | `ex_date` | Values |
| --- | --- | --- | --- | --- |
| A | `split` | `confirmed` | 2026-03-10 | `ratio_new = 2`, `ratio_old = 1` (2 : 1) |
| B | `cash_dividend` | `paid` | 2026-06-15 | `amount = 0.50`, `currency = 'USD'` |

Unadjusted closes: `2026-03-06: 100.00`, `2026-03-09: 102.00` (last cum-split session),
`2026-03-10: 51.00`, `2026-06-12: 50.00` (last cum-dividend session), `2026-06-15: 49.50`,
`2026-09-15: 55.00`.

Factors (`adjustmentFactors`): split `priceFactor = ratio_old/ratio_new = 0.50`,
`volumeFactor = 2`, `beforeDate = 2026-03-10`, `kind = 'split'`; dividend
`priceFactor = 1 − 0.50/50.00 = 0.99`, `volumeFactor = 1`, `beforeDate = 2026-06-15`,
`kind = 'dividend'` — where `50.00` is the **unadjusted** close of the last session before the ex-date
(CRSP/Yahoo convention). Tolerance on every factor: `1e-12`.

Expected close series per policy, tolerance `1e-9`:

| Date | `unadjusted` | `price` (cum factor) | `total_return` (cum factor) |
| --- | --- | --- | --- |
| 2026-03-06 | 100.00 | **50.000000** (0.50) | **49.500000** (0.495) |
| 2026-03-09 | 102.00 | **51.000000** (0.50) | **50.490000** (0.495) |
| 2026-03-10 | 51.00 | **51.000000** (1.00) | **50.490000** (0.99) |
| 2026-06-12 | 50.00 | **50.000000** (1.00) | **49.500000** (0.99) |
| 2026-06-15 | 49.50 | **49.500000** (1.00) | **49.500000** (1.00) |
| 2026-09-15 | 55.00 | **55.000000** (1.00) | **55.000000** (1.00) |

Derived assertions over the window 2026-03-06 → 2026-09-15: total return **+11.111111 %**
(55/49.50 − 1), price-adjusted **+10.000000 %** (55/50), unadjusted **−45.000000 %** (55/100) — the
three policies must not be interchangeable, and this case proves they are not. Volume on 2026-03-06 is
multiplied by 2 under both `price` and `total_return`, and left alone under `unadjusted`.

Status gating: a copy of action A with `status = 'cancelled'` and another with `status = 'estimated'`
must produce **no** factor at all under every policy, while `announced`, `confirmed` and `paid` all
apply. `totalReturnIndex()` on the same bars must equal the `total_return` series rebased to the first
close within `1e-9`.

**Case `adjust.aapl.fixture`** (real recorded data, `fixtures/golden/analytics/adjust/aapl.json`, values
fixed by DATA_MODEL §6.1): AAPL close **2020-08-28 = 499.23** unadjusted → policy `price` =
**124.8075** (4 : 1 on 2020-08-31); a pre-2014-06-09 close of **645.57** carries 1/28 (7 : 1 × 4 : 1) →
**23.0561**. Tolerance `1e-4` (the published figures are quoted to four decimals). The server path is
asserted separately in `packages/server/test/integration/functions/HP.adjust.test.ts`, including that
`meta.adjustments` lists the `FactorStep[]` actually applied.

**Case `adjust.asof`** (`packages/server/test/integration/functions/HP.adjust.test.ts`): a backtest run
with `knownAt = 2020-08-01` must **not** see a split whose `corporate_actions.tx_from` is 2020-08-31 —
the unadjusted series is returned and `meta.adjustments` is empty. This is REF-09 meeting REF-03.

### 7.10 Bitemporal as-of and point-in-time fundamentals (REF-03, STOR-06)

**Case `pit.restatement`** — `packages/server/test/integration/pit.fundamentals.test.ts`
(path named in DATA_MODEL §8.1). Setup inside the test transaction, on top of the seeded AAPL issuer
(`cik = '0000320193'`):

| Row | `concept` | `period_end` | `unit` | `value` | `filed_at` | `accession_no` |
| --- | --- | --- | --- | --- | --- | --- |
| original | `Revenues` | 2026-03-28 | `USD` | **111 184 000 000** | **2026-05-01** | `0000320193-26-000013` |
| restatement | `Revenues` | 2026-03-28 | `USD` | **110 984 000 000** | **2026-07-31** | `0000320193-26-000031` |

| Query | Expected | Tolerance |
| --- | --- | --- |
| `facts({cik, concepts:['Revenues'], unit:'USD', periods:'Q'}, knownAt = 2026-06-01)` | one row, **111 184 000 000**, `accession_no = 0000320193-26-000013` | exact |
| `facts(…, knownAt = 2026-09-01)` | one row, **110 984 000 000**, `accession_no = 0000320193-26-000031` | exact |
| `facts(…, knownAt = 2026-04-30)` | **zero rows** — the fact was not public yet | exact |
| `statements(issuerId, 'Q', knownAt = 2026-06-01)` | `revenue = 111 184 000 000`, `as_reported.REVENUE.fact_id` points at the original fact | exact |

The leak test is the whole point: **the restated value must never appear at an earlier `knownAt`.** The
test also asserts the negative direction — that the later query does not return *both* rows (the
`DISTINCT ON (period_end, period_start) … ORDER BY … filed_at DESC` contract) — and that
`meta.provenance[]` on the FA payload cites the accession that actually supplied the number.

**Case `bt.correction`** — `packages/server/test/integration/bitemporal.test.ts`
(worked query from DATA_MODEL §1.4). Note `91282CJK8` recorded 2026-03-01 with `coupon_rate = 4.500`
(reason `initial`), corrected 2026-03-10 to `4.250` (reason `correction`).

| `valid_at` | `known_at` | Expected `coupon_rate` |
| --- | --- | --- |
| 2026-03-14 | 2026-03-05T12:00Z | **4.500** |
| 2026-03-14 | 2026-03-12T00:00Z | **4.250** |

Plus: the `govt_terms_bt_excl` GiST exclusion constraint rejects an overlapping current version
(expect `23P01`); `bt_guard_update` rejects an `UPDATE` of a closed row; `writeVersion` followed by
`upsertVersion` with identical data returns `null` (no-op) and inserts no row.

### 7.11 Engine reproducibility (ANAL-08) — `packages/core/test/analytics/engine.test.ts`

For every engine registered through `defineEngine`: running it twice with the same inputs and the same
`valuationTs` yields bit-identical outputs and an identical `inputsHash`; changing any single input
changes `inputsHash`; the declared input set in `EngineResult.inputs` is exactly the set the function
read (asserted with a recording Proxy over the input object); and `engine.version` is present and
semver-shaped. The server-side twin is `packages/server/test/integration/curves.build.test.ts`
asserting the `curve_builds` unique key `(curve_id, curve_date, method, interpolation, engine_version,
inputs_hash)` de-duplicates an identical rebuild, and `vol_surfaces.inputs_hash` doing the same for
ANAL-04.

---

## 8. Provider replay tests (QA-02, FEED-08)

**Every file present in `fixtures/providers/raw/` is under test** — the manifest-integrity test asserts
that each file on disk is reachable from a `requestKey` (one each, save the two `yahoo-chart` files that
share a key) and that no manifest entry names a missing file; it never asserts a literal count, so adding
a capture does not break it. The directory holds
**48** entries today (counted on disk; BRIEF §2 and ARCHITECTURE L97 said 50, and WORKPLAN §18.14 records
the same correction). Three captures are missing outright and a fourth needs re-capturing — all four are a WP-05 task — until they land, their
adapters are covered by the catalogue half of the response only:

| Missing capture | Exact URL | Blocks |
| --- | --- | --- |
| IMF observations | `https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/USA` | `imf.datamapper` observation parse (PROVIDERS.b §10.7) |
| Bloomberg `wealth` feed | `https://feeds.bloomberg.com/wealth/news.rss` (record the redirected `https://www.bloomberg.com/feeds/…` URL as the request key, PROVIDERS.b §11.1) | the sixth `bbg.rss` feed |
| FOMC calendar page | `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` | `fed.fomc` parse (PROVIDERS.b §10.9) |
| AAPL daily history with splits (re-capture, replaces a bad one) | `https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=max&interval=1d&events=div%7Csplit` | §7.9 `adjust.aapl.fixture`: the stored `yahoo-chart-AAPL-max-1d.json` came back at `dataGranularity 3mo` (169 quarterly bars), so no daily close exists for 2020-08-28 or pre-2014 and that golden runs on published closes instead (WORKPLAN §18.14) |

When the three missing ones are captured, the count becomes 51 in one edit, here and in ARCHITECTURE L97. Nothing here
touches the network.

| Test | File | What it proves |
| --- | --- | --- |
| Request keys | `packages/server/test/replay/requestKey.test.ts` | `canonicalUrl()` obeys PROVIDERS §3.2 rules 1–5 — lower-cased scheme/host, dropped default port and fragment, `%5EGSPC`, `EURUSD%3DX`, `_SPX` preserved, query sorted by name then value, `events=div%7Csplit`, empty-value parameter kept as `name=`, `?` omitted when nothing survives. Two spellings of the same request must hash equal; two orderings of the same JSON body must hash **differently** (deliberate) |
| Manifest integrity | `packages/server/test/replay/manifest.test.ts` | every `captures[].sha256` matches the bytes on disk; every raw file is reachable from exactly one `requestKey`; `yahoo-chart-1m` and `yahoo-chart-AAPL-1d-1m.json` collide on one key and are both retained as `captures[0]`/`captures[1]` ordered by `capturedAt`; `yahoo-chart-events` and `yahoo-chart-AAPL-max-1d.json` do **not** collide |
| Importer idempotence | `packages/server/test/replay/import.test.ts` | running `scripts/fixtures-import.ts` twice produces a byte-identical `manifest.json` (two-space indent, trailing newline, keys sorted); an unmapped file in `raw/` is a hard error |
| Normaliser goldens | `packages/server/test/replay/normalisers.test.ts` (ARCHITECTURE §8.1) | each adapter's pure `parse()` over each raw file deep-equals `fixtures/providers/normalised/<file>.json`. Every raw file on disk (48 today) is parsed by exactly one adapter, but the mapping is **not** 1:1 in the other direction: several adapters own more than one file, and two files (`yahoo-chart-1m` and `yahoo-chart-AAPL-1d-1m.json`) share one `requestKey`, so the test iterates the manifest, not a count. Timestamp rules are part of the golden: Cboe `last_trade_time` ET→UTC into `ts.src`, Yahoo `meta.regularMarketTime` ×1000 into `capturedAt`, frankfurter `date` into `sourceTs` |
| Replay wall | `packages/server/test/replay/no-network.test.ts` (PROVIDERS §3.6) | with `PROVIDER_MODE=replay`, no `undici`/`http`/`https` request object is constructed during the entire suite; a miss raises `ReplayMissError` carrying `requestKey`, the `nearest` manifest URL and the fix line |
| Ingest through replay | `packages/server/test/integration/ingest/jobs.test.ts` | every job in `ingest/jobs/` runs end-to-end off the replay store into `bloomberg_test`, writes an `ingest_runs` row with `status='ok'` and non-null `fetched/inserted`, and stamps a `provenance` row whose `request_key` equals the manifest key for every written value (DATA-10) |
| Plant session replay | `packages/server/test/replay/sessions.test.ts` | every directory in `fixtures/sessions/` is replayed with a `VirtualClock` and diffed against its `expected.ndjson`, ignoring `ts.cap`/`ts.pub`; the first divergence is printed with subject and seq. Committed sessions: `cboe-aapl-poll`, `sim-ws-burst`, `sim-ws-backpressure`, `sim-ws-resync`, `fomc-release` (**addition required** — the session names are not fixed anywhere) |
| Bit-identity | `packages/server/test/replay/determinism.test.ts` | the same session replayed twice in one process, and once more in a fresh fork, produces identical state logs (FEED-08) |
| Function parity | `packages/server/test/parity/fn-parity.test.ts` | every manifest × seed securities: the REST payload, the CSV export and the WS snapshot carry the same values for the same fields (API-05) |

---

## 9. Parser fuzz tests (QA-05)

**"Fuzz all feed decoders. Malformed or out-of-spec exchange messages occur in production and must never
crash a handler."** Every pure `parse.ts` under `packages/server/src/providers/<id>/` is a target, plus
the three parsers in `packages/core`.

Harness (**addition required**): `packages/server/test/fuzz/mutate.ts` — a deterministic corpus mutator
seeded with `xoshiro128ss` from `providers/sim/prng.ts`, so no new dependency is introduced and a
failure is reproducible from the seed printed in the failure message. Mutations applied to each recorded
fixture: byte flips, truncation at a random offset, duplicated/removed JSON keys, type swaps
(number↔string↔null↔array), `NaN`/`Infinity`/`-0`/`1e400` numeric injection, unicode and lone-surrogate
injection, deeply nested arrays (depth 200), 10 MB repeats, empty body, and valid-JSON-wrong-shape.
Default `FUZZ_ITERATIONS = 10 000` per target in CI; `npm run test:fuzz` raises it to 100 000.

Invariants asserted for **every** target and **every** input: the parser either returns a value that
satisfies its zod schema, or throws a typed `ParseError` carrying `{ providerId, requestKey, path }`.
It never throws `TypeError`/`RangeError`, never returns `undefined`, never emits `NaN` in a numeric
field, never hangs (per-case timeout 50 ms), and never allocates unboundedly. A `ParseError` must be the
kind the scheduler converts into a `dq_events` row with `kind='parse_error'` — asserted once in
`packages/server/test/integration/ingest/parseError.test.ts`.

| Target parser | Seed corpus | Fuzz test file |
| --- | --- | --- |
| `providers/cboe/parse.ts` (quotes) | `cboe-quote-AAPL.json`, `cboe-spx`, `cboe-vix` | `packages/server/test/fuzz/cboe.quotes.fuzz.test.ts` |
| `providers/cboe/parse.ts` (options chain) | `cboe-options` (3 510 contracts) | `packages/server/test/fuzz/cboe.options.fuzz.test.ts` |
| `providers/cboe/parse.ts` (symbol book, EU indices) | `cboe-symbol-book.json`, `cboe-eu-indices` | `packages/server/test/fuzz/cboe.symbolbook.fuzz.test.ts` |
| `providers/yahoo/parse.ts` (chart + events) | `yahoo-chart-AAPL-1d-1m.json`, `yahoo-chart-AAPL-max-1d.json`, `yahoo-chart-SPX-5d-5m.json`, `yahoo-chart-events`, `yahoo-fx`, `yahoo-ftse`, `yahoo-bond` | `packages/server/test/fuzz/yahoo.chart.fuzz.test.ts` |
| `providers/yahoo/parse.ts` (search) | `yahoo-search` | `packages/server/test/fuzz/yahoo.search.fuzz.test.ts` |
| `providers/openfigi/parse.ts` | `openfigi-map`, `openfigi-search` | `packages/server/test/fuzz/openfigi.fuzz.test.ts` |
| `providers/sec/parse.ts` (companyfacts, submissions, frames) | `sec-companyfacts-AAPL.json`, `sec-submissions-AAPL.json`, `sec-spy-submissions.json`, `sec-frames-assets.json`, `sec-company-tickers.json` | `packages/server/test/fuzz/sec.json.fuzz.test.ts` |
| `providers/sec/parse.ts` (8-K atom, N-PORT XML) | `sec-8k-atom.xml`, `sec-nport-SPY-primary_doc.xml` | `packages/server/test/fuzz/sec.xml.fuzz.test.ts` |
| `providers/treasury/parse.ts` | `treasury-xml2`, `treasury-bills.xml` | `packages/server/test/fuzz/treasury.fuzz.test.ts` |
| `providers/fred/parse.ts` + `providers/fedH15/parse.ts` (CSV) | `fred-DGS10.csv` (16 881 rows), `fed-h15.csv` | `packages/server/test/fuzz/csv.fuzz.test.ts` |
| `providers/nyfed/parse.ts` | `nyfed-all`, `nyfed-effr.json`, `nyfed-sofr` | `packages/server/test/fuzz/nyfed.fuzz.test.ts` |
| `providers/bls/parse.ts`, `providers/worldbank/parse.ts`, `providers/imf/parse.ts`, `providers/frankfurter/parse.ts`, `providers/coingecko/parse.ts`, `providers/finra/parse.ts` | `bls-cpi.json`, `worldbank`, `imf-weo.json`, `frankfurter`, `coingecko-simple.json`, `finra-trace` | `packages/server/test/fuzz/json.misc.fuzz.test.ts` |
| `providers/bbgRss/parse.ts`, `providers/fedRss/parse.ts` | `bbg-rss-{markets,econ,politics,tech,industries}`, `fed-press-rss.xml` | `packages/server/test/fuzz/rss.fuzz.test.ts` |
| `providers/ssga/parse.ts` (xlsx) | `ssga-spy-holdings.xlsx` | `packages/server/test/fuzz/xlsx.fuzz.test.ts` — includes a zip-bomb guard and a corrupt-central-directory case |
| HTML calendar scrapers (`fred-releases.html`, `bls-schedule.html`, `wiki-sp500.html`) | those three files | `packages/server/test/fuzz/html.fuzz.test.ts` |
| `core/command/tokenizer.ts` + `parser.ts` | generated strings | `packages/core/test/command/parser.fuzz.test.ts` (FUNCTIONS §8): 100 k random strings incl. unicode, `<`, `/`, `=` — never throws, every `CommandProblem.span` lies inside the input, `parse(raw)[0]` is idempotent under re-parse of its `insertText` |
| `core/ids/{figi,isin,cusip,sedol,occ,securityRef}.ts` | generated strings | `packages/core/test/ids/ids.fuzz.test.ts` (**addition required**): parse never throws; `format(parse(x)) === x` for every accepted input; check digits reject every single-character mutation of a valid identifier |
| `core/formula/{lexer,parser,evaluator}.ts` | generated expressions | `packages/core/test/formula/formula.fuzz.test.ts` (**addition required**): never throws, bounded recursion depth, division by zero yields `null` not `Infinity` (CHRT-07) |

---

## 10. WebSocket protocol tests (BUS-01..08, NFR-02, ENTL-05, TERM-12)

Server-side tests drive `ws/gateway.ts` over a real `ws` socket against an app built by
`packages/server/src/test/app.ts`, with a `VirtualClock` and a `SimFeed` (`SIM_FEED=1`,
`rateHz` per case) so bursts are reproducible. Client-side tests drive `sdk/client/ws.ts` over an
in-memory duplex.

| # | Property | Test file | Assertion |
| --- | --- | --- | --- |
| 1 | Handshake order | `packages/server/test/integration/ws/handshake.test.ts` | `hello` → `welcome` (`protocol:1`, `heartbeatMs:15000`, `limits.maxSubscriptions:10000` web / `2000` api, `limits.maxFields:100`); `sub` → `subAck`, then **exactly one `snap` per accepted subject**, then deltas — asserted by recording frame order and failing if any `delta` for a subject precedes its `snap` |
| 2 | Snapshot completeness | same file | a `snap` carries the full subscribed field set for the granted tier; a field denied by the evaluator is `null` **and** carries a reason in `r`, never a stale number (ENTL-05) |
| 3 | **Sequence continuity via the prev-chain** | `packages/server/test/integration/ws/sequence.test.ts` | over a 2 000-update `SimFeed` burst on `q:<AAPL>`: for every consecutive pair of frames received by one session, `delta.prev === previous frame's seq`; the chain has **no gap** even though `seq` itself skips (conflation); `seq` is strictly increasing; the final `PX_LAST` equals the plant's last applied value |
| 4 | Client apply rule | `packages/sdk/test/quoteCache.test.ts` | `QuoteCache` applies iff `prev === lastSeq[s]`; drops iff `seq <= lastSeq[s]`; otherwise emits `resync {subjects:[s]}` and ignores subsequent deltas for `s` until a `snap` arrives. Driven by a hand-built frame script covering in-order, duplicate, stale, and gapped sequences |
| 5 | Delta merge semantics | `packages/sdk/test/quoteCache.test.ts` | a field absent from `f` is unchanged; `null` clears the value and renders blank; a delta never introduces an entitlement denial |
| 6 | **Conflation latest-value guarantee under a burst** | `packages/server/test/unit/ws/conflator.test.ts` | with `effectiveMs = 250` and a `SimFeed` at `rateHz = 50` for 10 virtual seconds: each subject appears **at most once per `batch`**, at most one `batch` per `effectiveMs`, and for **every field** the last flushed value equals the last applied value. Frame count ≤ `ceil(10 000/250) = 40` per subject |
| 7 | Conflation property test | `packages/server/test/unit/ws/conflator.prop.test.ts` | 500 seeded random schedules (arrival times, field subsets, flush jitter): the latest-value guarantee and the contiguous `prev` chain hold for every generated schedule. Failing seed is printed |
| 8 | Conflation floors | same file | `eod`-tier subjects flush at most every 60 000 ms; `n:*` headlines are **queued not conflated** — every headline is delivered once, in `publishedAt` order, and no headline is overwritten by a later one; the server never narrows `effectiveMs` below the client's requested value |
| 9 | **Snapshot-only resync after a forced disconnect** | `packages/server/test/integration/ws/resync.test.ts` | socket is killed mid-burst; the client reconnects with `hello {resume:true}` and re-`sub`s with `known: lastSeq[s]`; the server replies with a fresh `snap` per subject and **zero replayed deltas** (asserted by frame-type census). Applying the reconnect stream to the pre-disconnect cache is idempotent, gap-free and duplicate-free, and the resulting state equals a cold subscribe. `usage_events kind='ws.resync'` written; `ws_resync_gap` metric observed |
| 10 | Server-initiated resync | same file | a plant restart emits `resync {subjects:[…]}`; until the client re-`sub`s, **no** frames for those subjects are sent (asserted over 5 virtual seconds of feed) |
| 11 | **Slow-consumer ladder to 4008** | `packages/server/test/integration/ws/backpressure.test.ts` | a stalled reader plus `SimFeed rateHz=200` walks the §6.5 ladder in order: `bufferedAmount > 256 KiB` → `notice {kind:'slow-consumer', action:'conflation-widened'}` with `conflationMs` doubled and capped at 5 000; `> 2 MiB` → flush skipped with the dirty set **retained** (no value lost — verified by comparing post-recovery state against the plant); `> 2 MiB` for 10 000 ms → `status {st:'shed', reason:'SLOW_CONSUMER'}` per non-essential subject then `notice {action:'shed'}`; still over after another 10 000 ms → `notice {action:'disconnect-soon'}` then close **`4008 SLOW_CONSUMER`**. Every rung also writes a `dq_events kind='ws_backpressure'` row and a `usage_events kind='ws.slow'` row |
| 12 | Recovery rung | same file | `bufferedAmount < SOFT/4` for 3 consecutive flushes → `notice {action:'conflation-restored'}` and `effectiveMs` halved, never below the requested value |
| 13 | Overload floor (NFR-02) | `packages/server/test/integration/ws/overload.test.ts` | simulated event-loop lag > 200 ms sets a global floor `effectiveMs ≥ 1000`, sheds non-essential subjects first, and **never** sheds `PX_LAST`, `CHG_NET_1D`, `CHG_PCT_1D`; `sys:status` delta carries `PLANT_STATE='degraded'`, `CONFLATION_FLOOR_MS=1000` |
| 14 | **Entitlement downgrade reason codes** | `packages/server/test/integration/ws/entitlement.test.ts` | user `pm@demo` requesting `tier:'realtime'` on a Cboe subject receives one `downgrade {from:'realtime', to:'delayed', reason:'SOURCE_TIER_CAP'}` and `subAck.accepted[].reason = 'SOURCE_TIER_CAP'`; a grant-capped user gets `NOT_ENTITLED_TIER`; user `eod@demo` gets `snap.tier='eod'` with only `PX_OFFICIAL_CLOSE PX_CLOSE_1D PX_VOLUME PX_OPEN PX_HIGH PX_LOW` populated, every other field `null` with `r = 'TIER_EOD'`, flushed at most every 60 s; a user with no firm grant gets all fields `null`, `st:'blank'`, reason `NO_FIRM_ENTITLEMENT`; an API-key session on a source with `api_allowed=false` gets `subAck.rejected[{code:'NOT_ENTITLED'}]` with reason `LICENCE_FORBIDS_USAGE`. **A downgrade always yields the lower tier's fresh value or a blank — never a stale higher-tier value** (asserted by seeding a stale realtime value into the plant and proving it is not emitted) |
| 15 | Live grant change | same file | revoking a grant mid-session produces `downgrade` + `resync` → fresh `snap`; no delta ever carries a new denial |
| 16 | Subject grammar & rejections | `packages/server/test/integration/ws/limits.test.ts` | `f: []` accepted only for `c:`, `e:`, `n:`, `sys:`, `alerts:`, `room:` and rejected with `FIELD_UNKNOWN` for `q:`/`l:`/`b1m:`/`oc:`/`r:`; unknown subject → `SUBJECT_UNKNOWN`; a client subscribing to `PX_LAST` never receives `PX_BID` (BUS-02, field-mask bitset) |
| 17 | Limits and close codes | same file | > 10 000 subjects → `LIMIT` then `4011`; > 100 fields → `LIMIT`; frame > 64 KiB → `4002` preceded by `err {fatal:true}`; > 20 client messages/s for 3 s → `4029`; 45 s without `ping` → `4000`; second login for the same user → `4003 SESSION_SUPERSEDED` on the older socket plus an `access_log` row with `decision='deny', reason='CONCURRENT_SESSION'`; `hello.protocol = 2` → `4010` |
| 18 | Wire schema round trip | `packages/sdk/test/wire/ws.schema.test.ts` | every `ClientMsg`/`ServerMsg` variant encodes and decodes losslessly; an unknown `t` is rejected; `z.record(FieldId, …)` partial-record behaviour is pinned for zod 4; `batch.m` accepts only `Snap`/`Delta`/`Status` |
| 19 | Reconnect backoff | `packages/sdk/test/client/ws.reconnect.test.ts` | 250 ms → 8 s with jitter, driven by `VirtualClock`; `LiveState` transitions `open → resyncing → open`; `Subscription` objects survive the reconnect and are re-sent |
| 20 | Staleness recomputation | `packages/sdk/test/quoteCache.test.ts` + `packages/web/test/grid/LiveGrid.staleness.test.tsx` | with the socket silent, `valueState()` recomputed each virtual second moves `live → stale` at `3 × expectedIntervalMs` and the cell restyles (TERM-12); a dead socket never leaves a "live" number |

---

## 11. Entitlement tests (ENTL-01..06, SEC-03, API-06)

| Test | File | Assertion |
| --- | --- | --- |
| Rule order | `packages/server/test/integration/entitlements/evaluator.test.ts` | the eight rules of ARCHITECTURE §10 fire in order, first failure wins per field: unknown field → `FIELD_UNKNOWN`; licence gate → `LICENCE_FORBIDS_USAGE`; source ceiling → `SOURCE_TIER_CAP`; missing firm grant → `NO_FIRM_ENTITLEMENT`; missing user grant → `NO_USER_ENTITLEMENT`; requested > effective → `downgrade` + `NOT_ENTITLED_TIER`. Effective tier is `min(licence.max_tier, firm tier, user tier)` (ENTL-02) |
| **Server-side denial** | `packages/server/test/integration/entitlements/denial.test.ts` | `POST /data` and `POST /api/v1/functions/HP/run` as `eod@demo` return the payload with denied fields **`null` plus a reason** in `meta.entitlement` — the row is never sent and then hidden. A response body diff proves no denied value appears anywhere in the JSON. `GET /api/v1/functions/HP/csv` with any denied field returns **403** with the reason and exports nothing (rule 2: export never silently exports a subset) |
| Guard | `packages/server/test/unit/entitlement.guard.test.ts` | every method of every service in `server/src/data/` throws when constructed with a throwing evaluator — there is no data path without a decision (ENTL-01) |
| **`access_log` rows** | `packages/server/test/integration/entitlements/accessLog.test.ts` (uses `withCleanDb`, §4.4) | one row per `(user, instrument, field, decision)` for a `DES` launch and for a `ws.sub`, with `usage`, `purpose` (`'DES'`, `'ws.sub'`), `requested_tier`, granted `tier` (NULL on deny), `field_class`, `source_id`, `session_id`, `trace_id` and `decision`/`reason` matching the response. Rows land via the batched writer (`flushAccessLog()`), never on the response path — asserted by measuring that the route's p95 does not move when the buffer is full. `access_log` is WORM: an `UPDATE`/`DELETE` raises from `worm_block` (ENTL-04, REG-01) |
| Declarations | `packages/server/test/integration/entitlements/declarations.test.ts` | `GET /api/v1/admin/declarations?month=YYYY-MM` aggregates distinct users per `source_id × field_class × tier × usage` straight out of `access_log`, writes `usage_declarations` with a `query_sql_hash`, and reconciles `distinct_users` against `firms.seat_count` (ENTL-06, DATA-02) |
| Quotas | `packages/server/test/integration/entitlements/quotas.test.ts` | bearer sessions: 500 daily unique instruments → `QUOTA_EXCEEDED` (HTTP 429 and `subAck.rejected`); 2 000 000 monthly datapoints; 2 000 concurrent subscriptions (api) / 10 000 (web). `quota_counters` and `quota_instruments_seen` updated exactly once per counted access |
| Natural-person binding | `packages/server/test/integration/entitlements/session.test.ts` | one active session per user; a second login supersedes and increments `sessions.superseded_count`; the old WS closes `4003` and an `access_log` deny row with `CONCURRENT_SESSION` is written (ENTL-03, SEC-03) |
| Cache invalidation | `packages/server/test/integration/entitlements/cache.test.ts` | decisions cache for 60 s per `(userId, sourceId, fieldClass, usage)` and are invalidated immediately by a `config_versions` bump from `entitlement_grants_bump` / `licence_registry_bump` |
| Tenant isolation | `packages/server/test/integration/rls.isolation.test.ts` | as `Other Desk`, RLS returns zero rows for `Demo Capital` workspaces, watchlists, portfolios, rooms and messages; as `compliance@demo`, the supervisor path returns its own firm's messages only (SEC-05, SEC-06, MSG-02) |
| Screen-side rendering | `packages/web/test/screens/DES.test.tsx`, `packages/e2e/tests/entitlement.spec.ts` | the client **never filters**: it renders the blocked badge and the reason code the server sent |

---

## 12. Command parser and autocomplete (TERM-01, TERM-02, TERM-03)

| Test | File | Assertion |
| --- | --- | --- |
| Tokenizer/parser | `packages/core/test/command/parser.test.ts` | every worked example of FUNCTIONS §2.7; `parse()` never throws and returns ranked interpretations best-first; `CommandShape` for empty / shell / help / security / function / security+function / invalid; every `CommandProblem.code` reachable with a correct `span` |
| Args | `packages/core/test/command/args.test.ts` | every `ArgType` syntax; unparseable args produce `ARG_PARSE` with the offending span, never an exception |
| Context rules | `packages/web/test/command/dispatch.test.ts` | function-only input applies to the panel's current security; security-only input reloads the panel's current function; `NO_SECURITY_LOADED` when neither; frame stack push and `fn.launch` usage event with a minted `traceId` (TERM-03, FUNC-04) |
| Ranking | `packages/core/test/command/rank.test.ts` | R0–R3 scoring terms, tie-breaks, and the `W` / `CF` / `GP` collision cases; result length ≤ 12, best first |
| Index | `packages/core/test/command/index.test.ts` | prefix bounds, word index, trigram fallback thresholds, MRU boost |
| Local index | `packages/web/test/command/localIndex.test.ts` | `/universe/snapshot` ETag + IndexedDB cache; index built in a Worker in < 300 ms, never on the main thread; MRU rebuilt from history |
| **80 ms p95 on the seeded universe** | `packages/core/test/command/command.bench.ts` (vitest bench) | tokenize + parse + rank over the seeded universe index — ≈ 36 k instruments + 39 function codes + ≈ 60 people + 13 topics ≈ **45 k entries** — for a fixed 200-keystroke script (`A`, `AA`, `AAP`, `AAPL`, `AAPL U`, …, plus `GP`, `DES`, `WEI`, `T 4`, `EURUSD`). **≤ 4 ms p95, hard fail > 8 ms.** The local path needs no network, so the 80 ms p95 budget holds by construction for ≥ 95 % of keystrokes |
| Render frame | `packages/web/test/autocomplete.frame.test.tsx` | ≤ 12 memoised rows rendered inside one pumped frame, < 16 ms |
| Server fallback | `packages/server/test/integration/search.test.ts` (**addition required**) | `GET /api/v1/search` with a name query ≥ 3 chars uses the trigram indexes, returns ≤ 12 ranked candidates, and stays **< 80 ms p95** over 200 seeded queries measured in-process; `search_local_hit_ratio` ≥ 0.95 over the recorded keystroke script |
| End-to-end budget | `packages/e2e/tests/autocomplete.spec.ts` | Performance API marks `ac:start` → `ac:paint` per keystroke; p95 < 80 ms, cross-checked against `GET /api/v1/status` `timings.autocompleteP95Ms` |

---

## 13. LiveGrid component tests (TERM-08, TERM-12)

All under `packages/web/test/grid/` with jsdom + RTL and the real SDK decode path from §2.2.

| Test | File | Assertion |
| --- | --- | --- |
| **Flash on change** | `packages/web/test/grid/LiveGrid.flash.test.tsx` | feeding a `delta` that raises `PX_LAST` toggles `.flash-up` on exactly that cell and on no other; a fall toggles `.flash-down`; an unchanged field toggles nothing; `cell.textContent` equals `format(fieldId, value)` from core (the component does no arithmetic and no formatting of its own); `cell.dataset.state` equals the frame's `st`; the class is removed by `endFlash()` (700 ms lifetime asserted in Playwright). React is **not** on this path — the test asserts the React render count is unchanged across 500 deltas |
| Coalescing | `packages/web/test/grid/LiveGrid.raf.test.tsx` | 50 deltas delivered between two pumped frames produce exactly **one** rAF callback and one DOM write per cell, carrying the latest value |
| Staleness | `packages/web/test/grid/LiveGrid.staleness.test.tsx` | the 1 s sweep restyles cells to `stale` at `3 × expectedIntervalMs`, to `closed` on a session transition, and to `blank` on a denied field; the legend in `StatusBar` matches (TERM-12) |
| **Full keyboard operability** | `packages/web/test/grid/LiveGrid.keyboard.test.tsx` | with `user-event` only (no mouse): `ArrowUp/Down/Left/Right` move the focused cell, `Home/End` go to row start/end, `Ctrl+Home/End` to grid start/end, `PageUp/PageDown` move a viewport, `Enter` runs the row's `command`, `Space` toggles selection, `Tab` leaves the grid to the next widget and `Shift+Tab` returns, sorting via `Enter` on a `columnheader`, grouping toggle, and `Escape` returns focus to the command line without losing selection. Roles are asserted (`grid`, `row`, `gridcell`, `columnheader`), `aria-rowcount`/`aria-colcount` reflect the **full** model not the virtualised window, and `aria-sort` follows the sort state. No interactive element is reachable only by pointer |
| Virtualisation | `packages/web/test/grid/virtualiser.test.ts` | only visible rows + 10 overscan are rendered; scrolling emits an `essential` message marking rows off-viewport non-essential and re-`sub`s on `status {st:'shed'}` when they scroll back |
| Frame budget | `packages/web/test/grid.frame-budget.test.ts` | 2 000 visible cells receiving 5 000 field changes per second keep rAF callbacks **under 8 ms p95** in jsdom-instrumented timing |
| Screen renderer | `packages/web/test/screen/renderer.test.tsx` | every `Node` kind keyboard-operable; every `Cell` state (`live`/`stale`/`closed`/`blank`/`na`) renders distinguishably without relying on colour alone; `Ctrl+I` opens the provenance panel for the focused cell |

---

## 14. Playwright end-to-end flows

`packages/e2e/tests/` — Chrome via `channel: 'chrome'`, server in replay mode with `SIM_FEED=1`.

**`desk-flow.spec.ts` (addition required) — the one journey that proves the terminal works.** A single
test walking the required path, asserting at each step:

1. **Login.** `pm@demo` password login at `/`; the session cookie is set, `GET /health` is green, the
   status bar shows the connection state, the conflation interval and the trace id.
2. **`AAPL US Equity DES <GO>`.** Typed into the command line character by character (autocomplete
   visible, ≤ 12 rows); `<GO>` is the Enter key. Panel 1 shows the DES screen for AAPL: name, FIGI
   `BBG000B9XRY4`, CIK `0000320193`, GICS sector, and a `PX_LAST` cell whose value equals the REST
   payload for the same instrument (`fn-parity` in the browser). `usage_events kind='fn.launch'`,
   `code='DES'` is written.
3. **`GP <GO>`** (function-only — applies to the panel's current security, TERM-03). The canvas chart
   paints; the test asserts the chart's reported point count against `POST /data`, switches the range
   to 1Y, toggles the `TR` overlay, and confirms the overlay's first value equals the
   `total_return`-adjusted series from the server (REF-09).
4. **`HP <GO>` then PRINT (export).** The HP grid paginates; PRINT calls the server export endpoint and
   downloads a CSV. The test parses the CSV and asserts **cell-for-cell equality with the visible
   grid**, RFC 4180 quoting, CRLF line endings, UTF-8 without BOM, `#` attribution comment lines first,
   and the `As of` line (FUNC-03, API-05).
5. **`W <GO>`.** The "MAG7" watchlist loads in a `LiveGrid`; with `SIM_FEED` running, at least 20 cells
   flash within 3 s; the flash class is gone within 1 s of the change (700 ms animation); arrow-key
   navigation moves the focus ring; a formula column (`PX_LAST/PX_CLOSE_1D-1`) computes and re-computes
   live (CHRT-07).
6. **`WEI <GO>`.** The world equity index monitor renders all 31 seeded indices with regional grouping
   and per-row session state; rows for closed markets show the `closed` state, not a stale `live`.
7. **Panel switching.** `Ctrl+2`/`Ctrl+3`/`Ctrl+4` split to four panels, each with its own frame stack;
   the back key returns DES → GP within panel 1; the workspace persists across a page reload
   (`PUT /workspaces` optimistic `version`, TERM-04/05).
8. **`HELP`.** One press opens the context help overlay for the focused function (summary, params, keys,
   sources, related); a second press opens the ticket dialog and, on submit, creates a `help_tickets`
   row with `screen_state` and a helpdesk room (TERM-09).

Supporting specs, each already named in ARCHITECTURE §3.5 or FUNCTIONS §8 unless marked:

| Spec | Covers |
| --- | --- |
| `command-line.spec.ts` | security+function, function-only, security-only, invalid input and its problem span (TERM-01/03) |
| `autocomplete.spec.ts` | per-keystroke ranking and the < 80 ms budget (TERM-02) |
| `panels.spec.ts` | four panels, back-stack, workspace persistence (TERM-04/05) |
| `live-grid.spec.ts` | flash on a replayed session; staleness badge after the feed stops (TERM-08/12) |
| `export.spec.ts` | PRINT on HP equals screen values (FUNC-03) |
| `entitlement.spec.ts` | export denied → reason code shown; `eod@demo` sees blanks (ENTL-05) |
| `help.spec.ts` | HELP once / twice (TERM-09) |
| `chart.spec.ts` | canvas chart interactions, studies, annotations (CHRT-01/04/05) |
| `quote.spec.ts`, `rates.spec.ts`, `watchlist.spec.ts`, `fa-pit.spec.ts` | Q/QM, YAS/CRVF, W, FA point-in-time |
| `ws-resync.spec.ts` (**addition required**) | `serverProcess.killSocket()` mid-session → the grid shows `resyncing`, recovers to `open`, and every visible cell matches a fresh REST snapshot; no value regresses |
| `perf.spec.ts` (**addition required**) | the §15 browser budgets |

---

## 15. Performance budgets, locally checkable

Every budget in the REQUIREMENTS latency table maps to a measurement that runs on a developer laptop and
in CI, with no market data and no network.

| Budget (source) | Value | Measured by | Fail condition |
| --- | --- | --- | --- |
| Keystroke → visual feedback (NFR table) | < 16 ms | `packages/web/test/autocomplete.frame.test.tsx` (pumped-frame timing) and `packages/e2e/tests/perf.spec.ts` (Performance API marks `key:down` → `key:paint`) | p95 > 16 ms in the browser; p95 > 8 ms in jsdom |
| Autocomplete result set (NFR table, TERM-02) | < 80 ms p95 | `packages/core/test/command/command.bench.ts` (≤ 4 ms p95 on 45 k entries, hard fail > 8 ms) + `packages/server/test/integration/search.test.ts` (< 80 ms p95 in-process) + `autocomplete.spec.ts` marks | any of the three |
| Function launch → first paint (NFR table) | < 500 ms p95 | `packages/e2e/tests/perf.spec.ts`: 20 launches of `DES`, `GP`, `HP`, `W`, `WEI` from `<GO>` to the screen's `paint` mark, cross-read from `GET /api/v1/status` `timings` | p95 > 500 ms × the machine-class multiplier (§18 open question) |
| 1-year daily history (NFR table) | < 200 ms p95 | `packages/server/test/perf/history.perf.test.ts` (**addition required**): 100 runs of `data/historical.ts#bars` for 252 sessions on a seeded name; asserts the plan uses the `bars_daily` PK with yearly partition pruning (`EXPLAIN` contains `Index Scan` and at most 2 partitions) | p95 > 200 ms, or a sequential scan appears |
| Plant publish latency (ARCHITECTURE §6.2) | < 1 ms p99 in-process | `packages/server/test/perf/plant.perf.test.ts` (**addition required**): `plant_publish_latency_ms.observe(pub − cap)` over a 100 k-update `SimFeed` burst | p99 > 1 ms |
| Grid under load (ARCHITECTURE §6.6) | rAF < 8 ms p95 jsdom / < 16 ms browser | `packages/web/test/grid.frame-budget.test.ts` (2 000 cells, 5 000 changes/s) and `live-grid.spec.ts` | either |
| Conflation frame rate (BUS-03) | ≤ 1 batch per session per `effectiveMs` | `packages/server/test/unit/ws/conflator.test.ts` frame census | any extra batch |
| Universe index build (FUNCTIONS §3.5) | < 300 ms, in a Worker | `packages/web/test/command/localIndex.test.ts` | > 300 ms or built on the main thread |
| Seed + migrate (CI cost) | < 120 s cold | `packages/server/test/globalSetup.ts` logs the duration; CI step 4 timeout | > 120 s |

Peak-rate load testing (QA-04) is bounded by what is reachable offline: `SimFeed` at `rateHz = 200`
across 500 subjects for 60 virtual seconds is the standing burst profile (`fixtures/sessions/sim-ws-burst`).
It exercises NFR-02 degradation but does not size real capacity (NFR-01); that gap is recorded in
`docs/TRACEABILITY.md` as partially implemented.

---

## 16. Determinism and flake control

- **No sleeps.** Waiting is `VirtualClock.advance()` in unit/integration tests, `flushFrames()` in web
  tests and Playwright's auto-waiting assertions in e2e. A `setTimeout`-based wait in a test file fails
  `packages/server/test/lint/no-sleep.test.ts` (**addition required**), a source-scanning test.
- **No shared mutable seed rows.** Integration tests insert what they mutate.
- **Seeded randomness only.** Every fuzz, Monte Carlo and sim-feed run prints its seed; a failing seed is
  committed as a regression case in the relevant golden file.
- **Fixed timezone and locale.** `TZ=UTC` for vitest; `timezoneId: 'America/New_York'` for Playwright,
  because ET session boundaries are part of the assertions.
- **Retry policy.** Vitest: `retry: 0` — a flaky unit test is a bug. Playwright: `retries: 1` in CI only,
  and a test that passes only on retry is reported and triaged, not ignored.
- **Quarantine.** A test that cannot be made deterministic is moved to `*.flaky.test.ts`, excluded from
  the gate by an explicit `exclude` entry, and carries a dated TODO with an owner. The exclude list is
  asserted to be empty by `packages/server/test/lint/no-quarantine.test.ts` unless
  `ALLOW_QUARANTINE=1` — so the list cannot grow silently.

---

## 17. Additions required

Things this strategy needs that CONTRACTS.md (and the four spine documents it digests) do not define.
None of these invent a table, column, route, enum or wire type.

**Configuration and scripts**

1. `vitest.config.ts` at the repo root and `packages/{core,sdk,server,web}/vitest.config.ts`; the
   project names `core`, `sdk`, `server-unit`, `server-int`, `web`.
2. Setup files: `packages/sdk/test/setup.ts`, `packages/server/test/setup.unit.ts`,
   `packages/server/test/setup.int.ts`, `packages/web/test/setup.tsx`,
   `packages/server/test/globalSetup.ts`.
3. npm scripts: `test:watch`, `test:core`, `test:sdk`, `test:unit`, `test:server`, `test:integration`,
   `test:replay`, `test:parity`, `test:fuzz`, `test:web`, `bench`, `coverage`, `e2e:ui`,
   `db:test:reset`, `golden:update`, `typecheck`, `lint`, and `@terminal/server`'s `start:test`.
4. `TEST_DATABASE_URL` env (config.ts declares only `DATABASE_URL`), plus the harness guard that
   refuses any database not named `bloomberg_test`.
5. Env `FUZZ_ITERATIONS`, `ALLOW_GOLDEN_UPDATE`, `ALLOW_QUARANTINE`.
6. Dev dependencies not in the pinned list: `@testing-library/react`, `@testing-library/user-event`,
   `@testing-library/jest-dom`, `jsdom`, `@vitest/coverage-v8`. No property-testing library is added —
   the deterministic mutator in §9 uses `providers/sim/prng.ts`.
7. `SIM_FEED=0|1` env and `packages/server/src/providers/sim/{prng,feed,paths}.ts` — already flagged as
   an addition by PROVIDERS §4; this document depends on it for every WebSocket and grid timing test.

**Harness APIs**

8. `withCleanDb(tables)`, `flushAccessLog()`, `flushUsageEvents()`, `asUser()` and `savepoint()` on
   `packages/server/src/test/db.ts` (the file is named in ARCHITECTURE §3.3; its API is not).
9. `withTx()` in `server/src/db/client.ts` must use `SAVEPOINT`/`RELEASE` when already inside a
   transaction, otherwise the rollback harness cannot work.
10. `packages/e2e/fixtures/serverProcess.ts` helpers `restartServer()` and `killSocket()`.
11. `packages/web/test/harness/liveClient.ts` — an in-memory duplex that feeds real `ServerMsg` frames
    to a real `LiveClient`.
12. `packages/server/test/fuzz/mutate.ts` — the seeded corpus mutator.

**Data shapes**

13. The `GoldenCase` record (§7.1) and the file names under `fixtures/golden/analytics/` — only the
    directory and `adjust/aapl.json` are named upstream.
14. Session directory names under `fixtures/sessions/`: `cboe-aapl-poll`, `sim-ws-burst`,
    `sim-ws-backpressure`, `sim-ws-resync`, `fomc-release`.
15. The restated AAPL `Revenues` row in §7.10 (`110 984 000 000`, filed 2026-07-31, accession
    `0000320193-26-000031`) is **synthesised by the test**: the recorded
    `sec-companyfacts-AAPL.json` fixture contains no restatement of that period. The original row
    (111 184 000 000, filed 2026-05-01, `0000320193-26-000013`) is the one DATA_MODEL §8.1 names.
16. `EngineResult.outputs.method` (`'newton' | 'bisection'`) and the `{ ok:false, reason:'NO_ROOT_IN_BRACKET' }`
    return shape for the yield solver; `impliedVol` returning `null` with
    `reason:'NO_ARBITRAGE_BOUND'`. `defineEngine` is named in ARCHITECTURE §3.1; these output keys are not.
17. `Conventions.ddof` as an explicit statistics parameter (ANAL-07 requires "explicit and consistent
    conventions"; the field itself is not enumerated upstream).

**Test files not named in any existing document** (every other path in this document is already named in
ARCHITECTURE §3, DATA_MODEL §1.4/§8.1, FUNCTIONS §8 or PROVIDERS §3):
`packages/core/test/no-io.test.ts`, `packages/core/test/analytics/golden.test.ts`,
`packages/core/test/analytics/bsm.test.ts`, `packages/core/test/analytics/bsm.crosscheck.test.ts`,
`packages/core/test/analytics/bond.solver.test.ts`, `packages/core/test/analytics/daycount.test.ts`,
`packages/core/test/analytics/stats.test.ts`, `packages/core/test/analytics/engine.test.ts`,
`packages/core/test/adjust/corporateActions.test.ts`, `packages/core/test/ids/ids.fuzz.test.ts`,
`packages/core/test/formula/formula.fuzz.test.ts`,
`packages/sdk/test/quoteCache.test.ts`, `packages/sdk/test/wire/ws.schema.test.ts`,
`packages/sdk/test/client/ws.reconnect.test.ts`,
`packages/server/test/unit/ws/conflator.test.ts`, `packages/server/test/unit/ws/conflator.prop.test.ts`,
`packages/server/test/integration/ws/{handshake,sequence,resync,backpressure,overload,entitlement,limits}.test.ts`,
`packages/server/test/integration/entitlements/{evaluator,denial,accessLog,declarations,quotas,session,cache}.test.ts`,
`packages/server/test/integration/{rls.isolation,txnesting,partitions,seed,search,pit.fundamentals}.test.ts`,
`packages/server/test/integration/ingest/{jobs,lock,parseError}.test.ts`,
`packages/server/test/replay/{requestKey,manifest,import,sessions,determinism}.test.ts`,
`packages/server/test/fuzz/*.fuzz.test.ts` (16 files, §9),
`packages/server/test/perf/{history,plant}.perf.test.ts`,
`packages/server/test/lint/{no-sleep,no-quarantine}.test.ts`,
`packages/web/test/format/no-arithmetic.test.ts`,
`packages/web/test/grid/{LiveGrid.flash,LiveGrid.raf,LiveGrid.staleness,LiveGrid.keyboard}.test.tsx`,
`packages/web/test/grid/virtualiser.test.ts`,
`packages/e2e/tests/{desk-flow,ws-resync,perf}.spec.ts`.

---

## 18. Open questions

1. **Coverage numbers.** The thresholds in §6.3 are a proposal, not derived from any requirement. If the
   team wants a single number across the workspace instead of per-project floors, that is a one-line
   change but it will be dominated by `packages/core`'s size.
2. **CI hardware multiplier.** The 500 ms first-paint and 200 ms history budgets are user-facing numbers
   from the REQUIREMENTS table measured on a desk machine. CI runners are slower and variable. Proposal:
   assert `p95 ≤ budget × PERF_MULTIPLIER` with `PERF_MULTIPLIER=1` locally and a value calibrated once
   per runner class in CI, recorded in the repo. Unresolved: who owns the calibration.
3. **QA-03 (continuous reconciliation) offline.** Cross-source divergence needs two independent sources
   for the same value. Offline we have Cboe vs Yahoo for a handful of names and SEC frames vs
   companyfacts for fundamentals. Is a fixture-scale reconciliation test (`dq_events
   kind='cross_source_divergence'` raised on a seeded 1 % disagreement) sufficient evidence for QA-03,
   or does it stay "partially implemented" in TRACEABILITY?
4. **QA-04 (peak-rate load test).** `SimFeed` proves graceful degradation but not capacity. Do we accept
   NFR-01 as out of scope for v1, or add a throwaway load harness against a local server?
5. **ANAL-09's "independent implementation".** Offline, the second implementation is in-repo (tree, Monte
   Carlo, numerical derivatives, two root-finding methods). A genuinely independent oracle would mean
   committing values produced by an external library at fixture-capture time. Worth doing for the BSM and
   bond files, or is the closed-form + second-method pairing enough?
6. **Treasury accrual convention.** `govt_terms.day_count` permits both `'ACT/ACT'` and `'ACT/ACT-ISDA'`.
   §7.4 treats US Treasury note accrual as ACT/ACT **ICMA** (the market convention) and uses ISDA only
   where the terms say so. Confirm that the seeded `treasuries.json` rows carry `'ACT/ACT'` meaning ICMA,
   and that nothing writes `'ACT/ACT-ISDA'` for a Treasury note.
7. **e2e database sharing.** The Playwright job and the integration job both use `bloomberg_test`. Today
   they run sequentially (CI steps 6 then 9). If they are ever parallelised, e2e needs its own database
   or a schema-per-job scheme — the rollback harness cannot protect against a browser-driven write.
8. **`n:*` ordering under conflation.** §10 row 8 asserts headlines are queued and never overwritten. If a
   burst exceeds the session's frame budget, the queue must either grow or shed — API §6.4 does not say
   which. Needs a decision before `packages/server/test/unit/ws/conflator.test.ts` can pin it.
