// vitest.config.ts — the single root config, TESTING.md §2.1.
//
// NOT `vitest.workspace.ts`: the workspace file was deprecated in Vitest 3.2 in favour of
// `test.projects` and is gone in v4/v5. The pinned runner is `vitest ^5.0.0`, where a
// `vitest.workspace.ts` would run zero projects (WORKPLAN §1.1).
//
// Ten projects, in five scheduling groups. Group 0 is the four that share a machine — `core`,
// `sdk`, `server-unit`, `web` — then `server-int` alone, then the three that each need a database
// to themselves (`server-serial`, `server-seed`, `server-replay`), then `web-bench` and
// `core-bench`, each of which has to be the only thing resident while it times a budget. Every
// project's own comment below says which group it is in and why. `packages/e2e` is Playwright and
// is excluded from vitest entirely — it is driven by `npm run test:e2e`.

import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://localhost:5432/bloomberg_test';

/**
 * The `server-seed` project's own database. Separate from `bloomberg_test` on purpose — see that
 * project's comment below and the second DEVIATION in `packages/server/test/globalSetup.ts`.
 */
const SEED_DATABASE_URL =
  process.env.DATABASE_URL_SEED_TEST ?? 'postgres://localhost:5432/bloomberg_seed_test';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: 'packages/core',
          environment: 'node',
          // `*.bench.ts` is NOT included here, and it is not excluded for being optional — the
          // opposite. `test/command/command.bench.ts` is a real assertion suite rather than a
          // `vitest bench` benchmark: it asserts the FUNCTIONS.md §3.5 ranking budget (≤ 4 ms p95
          // on 45 k entries), a WORKPLAN L614 acceptance row that cannot be allowed to stop
          // running. It runs under `npm test` exactly as before; what changed is only WHEN, for the
          // same reason that moved the web benches into `web-bench`. See `core-bench` at the end of
          // this list for the measurement, and for what leaving it here was costing its neighbours.
          include: ['test/**/*.test.ts'],
          testTimeout: 5_000,
          // `threads` is the default pool.
          //
          // `maxWorkers: 2`, and the same two on `sdk`, `server-unit` and `web` below. None of the
          // four sets `groupOrder`, so all four default to 0 and Vitest 5 runs them as ONE
          // scheduling group — which, with `maxWorkers` left unset, means four projects each
          // sizing its own pool at `availableParallelism() - 1` and up to 28 workers competing for
          // 8 cores. The group then starves its own members, and what it starves first is every
          // suite that measures a wall clock:
          //
          //   * `web/test/command/localIndex.test.ts` read 386–499 ms against the 300 ms worker
          //     build CLIENT §16.1 asks for — a 246 ms build when it has a core. It failed all
          //     three full runs it was measured over.
          //   * `server/test/unit/providers/parse.fuzz.test.ts` (QA-05) timed out against the 10 s
          //     default below; it is a 4.7 s test unstarved. It failed all three.
          //   * `core/test/formula/formula.fuzz.test.ts` (QA-05, 25 000 random strings) timed out
          //     against the 5 s default. It failed one in three.
          //
          // Two is not a tuned number, it is one worker per core across the group: 4 projects × 2 =
          // 8 = `hw.ncpu`. Measured over the group's 114 files and 4 241 tests: uncapped 48 s with
          // three failures, capped 73 s with none, and capping at 3 instead was 67 s and also green
          // — so the margin is deliberately the safe end of a six-second spread. NOTHING IS
          // RELAXED: no budget, no timeout and no assertion moved. What changed is that the budgets
          // now measure the code instead of the scheduler, which is the same argument `web-bench`
          // and `core-bench` make further down, applied to the suites that cannot be moved out of
          // their own project because they are ordinary tests that happen to time one thing.
          maxWorkers: 2,
        },
      },
      {
        test: {
          name: 'sdk',
          root: 'packages/sdk',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          setupFiles: ['test/setup.ts'],
          testTimeout: 5_000,
          // One worker per core across the `groupOrder: 0` group — see `core` above for why, and
          // why all four members have to agree on the number.
          maxWorkers: 2,
        },
      },
      {
        test: {
          name: 'server-unit',
          root: 'packages/server',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          // `test/replay/**` is excluded with `test/integration/**`: the replay suites drive real
          // ingest jobs, and two of the three (`secNport`, `symbologyRefresh`) open the test
          // transaction through `src/test/db.ts`. This project has no `globalSetup`, so nothing
          // migrates the database for it, and it runs in sequence group 0 — BEFORE `server-int`.
          // They only ever passed here because an earlier integration run had already migrated
          // `bloomberg_test`; against a fresh database they fail with 42P01
          // (`relation "provenance" does not exist`), which is what a clean CI has. They have
          // their own project, `server-replay`, below.
          exclude: ['test/integration/**', 'test/replay/**'],
          setupFiles: ['test/setup.unit.ts'],
          env: { PROVIDER_MODE: 'replay' },
          testTimeout: 10_000,
          // One worker per core across the `groupOrder: 0` group — see `core` above. This project is
          // where the starvation was loudest: `test/unit/providers/parse.fuzz.test.ts` is a 4.7 s
          // QA-05 totality proof that spent the 10 s above on waiting for a core, and
          // `test/parity/fn-parity.test.ts` boots the production Fastify app inside a `beforeAll`,
          // where Fastify's own 10 s `pluginTimeout` on `generatedRoutes` is the thing that trips.
          maxWorkers: 2,
        },
      },
      {
        test: {
          name: 'server-int',
          root: 'packages/server',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          // Partition maintenance is DDL: `CREATE TABLE … PARTITION OF` and `ATTACH PARTITION`
          // take ACCESS EXCLUSIVE on the parent, and every file here holds one transaction open
          // for its whole duration (`withTxDb`). So a single DDL file does not merely contend —
          // it blocks every other file that touches `quote_ticks` until it finishes, which is why
          // `Q` and `DES` timed out in their `beforeAll` while passing in three seconds alone.
          // The DDL suites run in `server-serial` instead, one at a time, after this project.
          //
          // The function suites join them, for a different reason with the same shape. Each of
          // them seeds the same shared reference tables — `entitlement_grants`, `licence_registry`,
          // `classification_codes` — from its own hook, in its own order, inside a transaction it
          // holds for the whole file. Two files inserting into those tables in opposite orders
          // deadlock, and Postgres kills one of them: observed repeatedly in `DES`, `GP` and
          // `reference-routes`, always in a seeding hook and never in a payload assertion, each
          // passing alone. Worker tuning only changes how often it happens, because the cause is
          // lock ORDER rather than lock contention.
          //
          // The real fix is one seeding helper that touches those tables in a fixed order, which
          // is a refactor across nineteen files and belongs with WP-15's harness work. Until then
          // these run one at a time, which is deterministic today and costs about a minute.
          exclude: [
            'test/integration/ingest/partitions.test.ts',
            'test/integration/functions/**/*.test.ts',
            // The seed suites need the opposite starting state from everything else here: a
            // database with the whole §18 universe in it, where these files need their own tables
            // empty so that "my job inserted N rows" means something. They run in `server-seed`
            // below, against their own database. See the second DEVIATION in test/globalSetup.ts.
            'test/integration/seed/**/*.test.ts',
          ],
          setupFiles: ['test/setup.int.ts'],
          globalSetup: ['test/globalSetup.ts'],
          env: {
            DATABASE_URL: TEST_DATABASE_URL,
            PROVIDER_MODE: 'replay',
          },
          // `forks`, not `threads`: the pg pool, the advisory-lock leader election
          // (ingest/lock.ts) and the batched entitlements/accessLog.ts writer all keep
          // process-level state, and fork isolation is what lets four integration files run
          // concurrently against one database (TESTING §2.1).
          //
          // `poolOptions` was removed in Vitest 4 — these are the top-level equivalents of
          // TESTING §2.1's `singleFork: false, maxForks: 4`.
          pool: 'forks',
          fileParallelism: true,
          maxWorkers: 4,
          // Vitest 5 runs every project sharing a `groupOrder` as ONE scheduling group, so the
          // worker counts of a group's members add up against the same cores. Four is the number
          // one Postgres will take (TESTING §2.1) and it is not a number to share: run in group 0
          // beside the four projects that agree on two threads each, these four forks would make
          // the group twelve workers on eight cores — the starvation documented at `core` above,
          // with a database on the other end of it. So `server-int` takes a group of its own, and
          // group 0 runs to completion first.
          sequence: { groupOrder: 1 },
          testTimeout: 30_000,
          // Hooks get the same budget as tests. The default is 10 s, which was enough while the
          // integration suite was small; WP-09 roughly doubled the file count and its `beforeAll`
          // hooks seed a whole screen's worth of reference data, quotes, news and messages. Four
          // of those running at once against one Postgres is ordinary contention, not a fault, and
          // a hook that needs twelve seconds under load should wait rather than fail the file and
          // cascade every test in it. A genuinely stuck hook still fails — at 60 s, not 10.
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          // `server-serial`: the suites whose statements take table-level locks. Partition
          // maintenance is the whole membership today — it creates, attaches and drops
          // partitions of `quote_ticks` and the five other partitioned parents, each of which
          // takes ACCESS EXCLUSIVE on the parent and holds it until the file's transaction ends.
          //
          // Run beside the ordinary integration files that is not contention to be tuned away: a
          // reader cannot proceed at all while the parent is locked, so those files block for the
          // DDL file's entire run and fail in their setup hook. One worker, one file at a time,
          // after `server-int`, is the only arrangement where both halves are deterministic.
          name: 'server-serial',
          root: 'packages/server',
          environment: 'node',
          include: [
            'test/integration/ingest/partitions.test.ts',
            'test/integration/functions/**/*.test.ts',
          ],
          setupFiles: ['test/setup.int.ts'],
          globalSetup: ['test/globalSetup.ts'],
          env: {
            DATABASE_URL: TEST_DATABASE_URL,
            PROVIDER_MODE: 'replay',
          },
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          // `server-seed`: the suites that assert the seed itself (TESTING §4.2 step 6,
          // DATA_MODEL §18), and the ONLY project whose `globalSetup` runs the thirteen-module seed.
          //
          // It owns its own database. That is the whole point rather than a detail: `volumes.test.ts`
          // can only assert §18's row counts against a database that HAS them, and the ~145 ingest
          // and function tests in the projects above can only assert what their own job inserted
          // against tables that DO NOT. One database cannot be both, and the collision is not a
          // matter of counts — `ingest/marketDataJobs.test.ts` writes an `md_lines` version valid
          // from 2020 where the seed holds one from 2026, and `md_lines_symbol_excl` correctly
          // refuses two open-ended ranges for one (source, symbol), so all 8 of its tests fail with
          // 23P01. Separate databases, and neither side has to lie.
          //
          // `SEED_TEST_DB=1` is what switches the seed on in the shared `globalSetup`; unset, that
          // step is skipped, which is what keeps this package from adding 167 s to every other
          // project's run. One worker: the seed is one long transaction per module and there is
          // nothing here to parallelise. `hookTimeout` is generous because a COLD seed is ~170 s —
          // a warm one is under a second, because module two onwards are idempotent.
          name: 'server-seed',
          root: 'packages/server',
          environment: 'node',
          include: ['test/integration/seed/**/*.test.ts'],
          setupFiles: ['test/setup.int.ts'],
          globalSetup: ['test/globalSetup.ts'],
          env: {
            // BOTH names, and that is not redundancy: `src/test/db.ts#testDatabaseUrl()` prefers
            // `DATABASE_URL_TEST` over `DATABASE_URL`, and the former is set ambiently (by `.env`
            // and by globalSetup's own defaults) to `bloomberg_test`. Setting only `DATABASE_URL`
            // here sent globalSetup to the seed database while every test in this project read the
            // other one — and the DATA-10 suites PASSED against the empty database they found,
            // because "every seeded value resolves to a fixture" is vacuously true with no values.
            DATABASE_URL: SEED_DATABASE_URL,
            DATABASE_URL_TEST: SEED_DATABASE_URL,
            PROVIDER_MODE: 'replay',
            SEED_TEST_DB: '1',
          },
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
          testTimeout: 60_000,
          hookTimeout: 300_000,
        },
      },
      {
        test: {
          // `server-replay`: the fixture-replay suites (TESTING §6), which drive a whole ingest
          // job from a recorded capture into the database. They need what `server-int` has —
          // `globalSetup`'s migrations, the forced test `DATABASE_URL`, `PROVIDER_MODE=replay` —
          // and one thing it cannot give them: no concurrency at all. Each of them writes the
          // real identifier space of its capture (`secNport` and `symbologyRefresh` both write
          // Apple's ISIN), so two replay transactions running side by side contend on the same
          // `identifiers` keys and Postgres resolves it as a deadlock. One worker, one file at a
          // time, after the integration project.
          name: 'server-replay',
          root: 'packages/server',
          environment: 'node',
          include: ['test/replay/**/*.test.ts'],
          setupFiles: ['test/setup.int.ts'],
          globalSetup: ['test/globalSetup.ts'],
          env: {
            DATABASE_URL: TEST_DATABASE_URL,
            PROVIDER_MODE: 'replay',
          },
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'web',
          root: 'packages/web',
          environment: 'jsdom',
          // The `*.bench.{ts,tsx}` files that used to be included here now run in `web-bench`
          // below. They still run under `npm test` — they are acceptance rows, not optional — but
          // they cannot share a machine with 240 other files and still mean anything.
          include: ['test/**/*.test.{ts,tsx}'],
          setupFiles: ['test/setup.tsx'],
          testTimeout: 10_000,
          // One worker per core across the `groupOrder: 0` group — see `core` above. The suite this
          // keeps honest here is `test/command/localIndex.test.ts`, whose 300 ms worker-build budget
          // (CLIENT §16.1) is an ordinary assertion in an ordinary test file and so cannot be moved
          // into `web-bench` the way the three `*.bench.tsx` files were.
          maxWorkers: 2,
        },
      },
      {
        test: {
          // `web-bench`: the three web suites that ASSERT a wall-clock budget rather than print
          // one — `chart/chart.bench.ts` (CHRT-02, WORKPLAN L1489), `grid/frame-budget.bench.ts`
          // (NFR-02) and `shell/autocomplete.bench.ts` (TERM-02, WORKPLAN L1407). They are
          // acceptance rows and run with the suite; what changes is only WHEN.
          //
          // They were running in the `web` pool beside ~240 other files, which made the budgets
          // measure the runner instead of the code. CHRT-02's ten-year pan-and-zoom is the case
          // that exposed it: 3.1–4.9 ms p95 when it has the machine, 9.7–19.8 ms in the full
          // parallel suite against a 16 ms budget, failing two rounds in five on load alone. The
          // engine did not change between those runs; the number of threads competing for a core
          // did. `grid/frame-budget.bench.ts` is itself a 2 200-cell burst that drives frames to
          // 84–103 ms, so the bench files were also each other's noise.
          //
          // NO BUDGET IS RELAXED BY THIS and none may be: every threshold is the same number it
          // was in the `web` project. Contention only ever inflates a p95, so a slow build under
          // this project is the code being slow, and a real regression now shows up instead of
          // drowning in scheduling jitter. Same shape and same reason as `server-serial` and
          // `server-replay` above: some suites cannot be run beside their neighbours at all.
          //
          // `groupOrder: 3` puts them in a group of their own after every other project, so
          // nothing else is resident while they time; `fileParallelism: false` with one worker
          // keeps the three from racing each other. `testTimeout` is 30 s because a bench file
          // runs five rounds of real work, not because any of them is allowed to be slow.
          name: 'web-bench',
          root: 'packages/web',
          environment: 'jsdom',
          include: ['test/**/*.bench.{ts,tsx}'],
          setupFiles: ['test/setup.tsx'],
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 3 },
          testTimeout: 30_000,
        },
      },
      {
        test: {
          // `core-bench`: `test/command/command.bench.ts` alone — the TERM-02 ranking budget of
          // FUNCTIONS.md §3.5 L972 (≤ 4 ms p95 over a 45 k-entry index, WORKPLAN L614). Same shape,
          // same reason and the same prohibition as `web-bench` above: NO BUDGET IS RELAXED BY
          // THIS. Every threshold is the number it was in the `core` project — 4 ms for the median
          // round's p95, and the 8 ms ceiling that every one of the five rounds must still clear.
          //
          // What leaving it in the `core` pool cost, measured on one machine over three full runs.
          // The file builds a 45 000-entry index and ranks 480 queries five times over, on `core`'s
          // default seven threads, while `sdk`, `server-unit` and `web` run in the same scheduling
          // group: `groupOrder` defaults to 0 for all four, so up to 28 workers compete for 8
          // cores. The budget then measures the scheduler and not the ranker — p95 median 5.987 ms
          // contended against 0.612 ms with the machine to itself, and the index build 1 532 ms
          // against 174 ms. It failed one full run in three, and `rank()` did not change between
          // them.
          //
          // It was also its NEIGHBOURS' noise, which is the half that is easy to miss and the half
          // that was actually turning the suite red. With this file in the group, two QA-05 totality
          // proofs time out against the framework defaults they never meant as budgets
          // (`core/test/formula/formula.fuzz.test.ts` at 5 s, `server/test/unit/providers/
          // parse.fuzz.test.ts` at 10 s, the latter a 4.7 s test when it is not starved), and
          // `web/test/command/localIndex.test.ts` reads 386–499 ms against the 300 ms worker build
          // CLIENT §16.1 asks for — a 246 ms build when it has a core. Run those same three
          // projects WITHOUT `core`: 70 files, 2 725 tests, green in 48 s. None of the three is
          // slow; all three were starved by this one file.
          //
          // `groupOrder: 4` and not 3, deliberately: `web-bench`'s note above requires that nothing
          // be resident while it times, and a node process burning a core on a 45 k-entry index
          // would be exactly that. The two bench groups run one after the other, each alone.
          name: 'core-bench',
          root: 'packages/core',
          environment: 'node',
          include: ['test/**/*.bench.ts'],
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 4 },
          testTimeout: 30_000,
        },
      },
    ],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './reports/vitest-junit.xml' },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      exclude: [
        '**/*.d.ts',
        '**/manifests/index.ts',
        '**/jobs/index.ts',
        '**/screens/index.ts',
        '**/functions/index.ts',
        'packages/*/test/**',
        'fixtures/**',
        'scripts/**',
      ],
    },
  },
});
