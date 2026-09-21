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
          include: ['test/**/*.test.{ts,tsx}'],
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
