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
          // `*.bench.ts` is included for the same reason it is in `core`: `test/shell/
          // autocomplete.bench.ts` is a WP-12 acceptance row (WORKPLAN L1407) that ASSERTS the
          // 80 ms p95 and 16 ms keystroke budgets rather than printing them, so it must run with
          // the suite. Vitest's own `bench()` blocks are unaffected by `include`.
          include: ['test/**/*.test.{ts,tsx}', 'test/**/*.bench.{ts,tsx}'],
          setupFiles: ['test/setup.tsx'],
          testTimeout: 10_000,
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
