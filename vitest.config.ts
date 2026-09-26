// vitest.config.ts — the single root config, TESTING.md §2.1.
//
// NOT `vitest.workspace.ts`: the workspace file was deprecated in Vitest 3.2 in favour of
// `test.projects` and is gone in v4/v5. The pinned runner is `vitest ^5.0.0`, where a
// `vitest.workspace.ts` would run zero projects (WORKPLAN §1.1).
//
// Five projects: core, sdk, server-unit, server-int, web. `packages/e2e` is Playwright and is
// excluded from vitest entirely — it is driven by `npm run test:e2e`.

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
          // `*.bench.ts` is included because `test/command/command.bench.ts` is a real assertion
          // suite, not a `vitest bench` benchmark: it asserts the FUNCTIONS.md §3.5 ranking budget
          // (≤ 4 ms p95 on 45 k entries), which is a WORKPLAN L614 acceptance row and cannot be
          // allowed to stop running. Vitest's own `bench()` blocks are unaffected by `include`.
          include: ['test/**/*.test.ts', 'test/**/*.bench.ts'],
          testTimeout: 5_000,
          // `threads` is the default pool.
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
          // Vitest 5 runs every project sharing a `groupOrder` in one scheduling group and refuses
          // a group whose members disagree about `maxWorkers`. `server-int` is the only project
          // that pins a worker count (four forks against one database), so it gets its own group;
          // the other four stay on the default group 0 and run first.
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
