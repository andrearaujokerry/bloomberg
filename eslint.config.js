// eslint.config.js — flat config, ESLint 9.
//
// Three structural rule groups make the dependency table of ARCHITECTURE L59-77 a compiler-time
// fact rather than an aspiration (WORKPLAN §1.2):
//
//   1. package boundaries       — import/no-restricted-paths (cross-package *source* imports)
//                                 + no-restricted-imports    (forbidden *bare* specifiers)
//   2. forbidden globals        — no IO in web/src, no ambient clock in core/src
//   3. typed-lint hygiene       — typescript-eslint type-checked preset, no process.env at large
//
// Every zone in groups 1 and 2 is scoped to `packages/*/src/**`, NEVER to a whole package:
// `packages/*/test/**` is deliberately outside them (WP-02's analytics goldens read fixtures from
// disk with `node:fs`, harnesses use `Date`, etc.).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name) => path.join(rootDir, 'packages', name);

/** Source zones only — tests, configs and fixtures are outside every boundary rule. */
const SRC = {
  core: `${pkg('core')}/src`,
  sdk: `${pkg('sdk')}/src`,
  server: `${pkg('server')}/src`,
  web: `${pkg('web')}/src`,
  e2e: pkg('e2e'),
};

const NODE_BUILTINS = [
  'node:*',
  'fs',
  'fs/promises',
  'path',
  'os',
  'crypto',
  'child_process',
  'http',
  'https',
  'net',
  'tls',
  'worker_threads',
  'stream',
  'util',
  'url',
  'zlib',
];

const g = (name, message) => ({ name, message });

/** `packages/core` — pure, synchronous, no IO, no framework. May import `zod` and itself. */
const CORE_FORBIDDEN_IMPORTS = [
  ...NODE_BUILTINS.map((name) =>
    g(name, 'packages/core is pure: no node builtins, no IO — ARCHITECTURE L120.'),
  ),
  g('pg', 'packages/core may not touch the database — ARCHITECTURE L59-77.'),
  g('drizzle-orm', 'packages/core may not touch the database — ARCHITECTURE L59-77.'),
  g('fastify', 'packages/core may not import a server framework — ARCHITECTURE L59-77.'),
  g('ws', 'packages/core may not import a transport — ARCHITECTURE L59-77.'),
  g('undici', 'packages/core may not perform IO — ARCHITECTURE L59-77.'),
  g('pino', 'packages/core may not import a logger — ARCHITECTURE L59-77.'),
  g('react', 'packages/core may not import UI — ARCHITECTURE L59-77.'),
  g('react-dom', 'packages/core may not import UI — ARCHITECTURE L59-77.'),
  g('zustand', 'packages/core may not import UI state — ARCHITECTURE L59-77.'),
  g('@terminal/sdk', 'packages/core may not depend on @terminal/sdk — ARCHITECTURE L59-77.'),
  g('@terminal/server', 'packages/core may not depend on @terminal/server — ARCHITECTURE L59-77.'),
  g('@terminal/web', 'packages/core may not depend on @terminal/web — ARCHITECTURE L59-77.'),
];

/** `packages/sdk` — the only IO boundary the client has. May import `@terminal/core` and `zod`. */
const SDK_FORBIDDEN_IMPORTS = [
  ...NODE_BUILTINS.map((name) =>
    g(name, 'packages/sdk runs in the browser: no node builtins — ARCHITECTURE L59-77.'),
  ),
  g('pg', 'packages/sdk may not touch the database — ARCHITECTURE L59-77.'),
  g('drizzle-orm', 'packages/sdk may not touch the database — ARCHITECTURE L59-77.'),
  g('fastify', 'packages/sdk may not import a server framework — ARCHITECTURE L59-77.'),
  g('ws', 'packages/sdk uses the platform WebSocket, not the `ws` package — ARCHITECTURE L59-77.'),
  g('react', 'packages/sdk is framework-free — ARCHITECTURE L59-77.'),
  g('react-dom', 'packages/sdk is framework-free — ARCHITECTURE L59-77.'),
  g('@terminal/server', 'packages/sdk may not depend on @terminal/server — ARCHITECTURE L59-77.'),
  g('@terminal/web', 'packages/sdk may not depend on @terminal/web — ARCHITECTURE L59-77.'),
];

/** `packages/server` — may import core, sdk, fastify, ws, pg, drizzle-orm, pino, undici. */
const SERVER_FORBIDDEN_IMPORTS = [
  g('react', 'packages/server may not import UI — ARCHITECTURE L59-77.'),
  g('react-dom', 'packages/server may not import UI — ARCHITECTURE L59-77.'),
  g('zustand', 'packages/server may not import UI state — ARCHITECTURE L59-77.'),
  g('@terminal/web', 'packages/server may not depend on @terminal/web — ARCHITECTURE L59-77.'),
];

/** `packages/web` — may import core, sdk, react, react-dom, zustand. All IO via @terminal/sdk. */
const WEB_FORBIDDEN_IMPORTS = [
  ...NODE_BUILTINS.map((name) =>
    g(name, 'packages/web runs in the browser: no node builtins — ARCHITECTURE L59-77.'),
  ),
  g('pg', 'packages/web may not touch the database — ARCHITECTURE L59-77.'),
  g('drizzle-orm', 'packages/web may not touch the database — ARCHITECTURE L59-77.'),
  g('fastify', 'packages/web may not import a server framework — ARCHITECTURE L59-77.'),
  g('ws', 'all IO goes through @terminal/sdk — API-05.'),
  g('undici', 'all IO goes through @terminal/sdk — API-05.'),
  g('pino', 'packages/web may not import the server logger — ARCHITECTURE L59-77.'),
  g('@terminal/server', 'packages/web may not depend on @terminal/server — ARCHITECTURE L59-77.'),
];

/** `packages/e2e` — may import `@playwright/test` only, never any package source. */
const E2E_FORBIDDEN_IMPORTS = [
  g('@terminal/core', 'packages/e2e drives the built app, never package source — WORKPLAN §1.2.'),
  g('@terminal/sdk', 'packages/e2e drives the built app, never package source — WORKPLAN §1.2.'),
  g('@terminal/server', 'packages/e2e drives the built app, never package source — WORKPLAN §1.2.'),
  g('@terminal/web', 'packages/e2e drives the built app, never package source — WORKPLAN §1.2.'),
];

const restrictedImports = (paths) => [
  'error',
  {
    paths: paths.filter((p) => !p.name.includes('*')),
    patterns: paths
      .filter((p) => p.name.includes('*'))
      .map((p) => ({ group: [p.name], message: p.message })),
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-types/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/reports/**',
      '**/*.tsbuildinfo',
      'packages/server/drizzle/migrations/**',
      'fixtures/**',
    ],
  },

  js.configs.recommended,

  // ── Group 3: type-checked preset, TypeScript sources only ───────────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        // One lint-only program (see tsconfig.eslint.json) rather than `projectService`: the five
        // package tsconfigs include `src/**` only, so tests, scripts and root config files would
        // otherwise have no program at all.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-definitions': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'process.env is read once, in packages/server/src/config.ts (or scripts/**). Everything else takes config as a parameter — ARCHITECTURE L248-250.',
        },
      ],
    },
  },

  // `server/src/config.ts` and `scripts/**` are the two places that may read the environment.
  {
    files: ['packages/server/src/config.ts', 'scripts/**/*.ts', '*.ts', '*.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // ── Group 1: package boundaries, source zones only ──────────────────────────────────────────
  {
    files: ['packages/*/src/**/*.{ts,tsx}', 'packages/e2e/**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      // The TypeScript resolver is what makes `import/no-restricted-paths` bite: sources use
      // `.js` extensions on relative ESM imports (NodeNext), and the plain node resolver cannot
      // map `../../server/src/index.js` back to `index.ts`. An unresolved specifier is silently
      // skipped by the rule, so without this the cross-package zones below would never fire.
      'import/resolver': {
        typescript: { project: path.join(rootDir, 'tsconfig.eslint.json') },
        node: { extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'] },
      },
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          basePath: rootDir,
          zones: [
            {
              target: SRC.core,
              from: [SRC.sdk, SRC.server, SRC.web, SRC.e2e],
              message: 'packages/core sits at the bottom of the stack — ARCHITECTURE L59-77.',
            },
            {
              target: SRC.sdk,
              from: [SRC.server, SRC.web, SRC.e2e],
              message: 'packages/sdk may import @terminal/core only — ARCHITECTURE L59-77.',
            },
            {
              target: SRC.server,
              from: [SRC.web, SRC.e2e],
              message: 'packages/server may not reach into the web app — ARCHITECTURE L59-77.',
            },
            {
              target: SRC.web,
              from: [SRC.server, SRC.e2e],
              message: 'packages/web talks to the server over the wire only — API-05.',
            },
            {
              target: SRC.e2e,
              from: [SRC.core, SRC.sdk, SRC.server, SRC.web],
              message: 'packages/e2e drives the built app, never package source — WORKPLAN §1.2.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['packages/core/src/**/*.ts'],
    rules: { 'no-restricted-imports': restrictedImports(CORE_FORBIDDEN_IMPORTS) },
  },
  {
    files: ['packages/sdk/src/**/*.ts'],
    rules: { 'no-restricted-imports': restrictedImports(SDK_FORBIDDEN_IMPORTS) },
  },
  {
    files: ['packages/server/src/**/*.ts'],
    rules: { 'no-restricted-imports': restrictedImports(SERVER_FORBIDDEN_IMPORTS) },
  },
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrictedImports(WEB_FORBIDDEN_IMPORTS) },
  },
  {
    files: ['packages/e2e/**/*.ts'],
    rules: { 'no-restricted-imports': restrictedImports(E2E_FORBIDDEN_IMPORTS) },
  },

  // ── Group 2: forbidden globals, source zones only ───────────────────────────────────────────
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'all IO goes through @terminal/sdk — API-05' },
        { name: 'WebSocket', message: 'all IO goes through @terminal/sdk — API-05' },
        { name: 'XMLHttpRequest', message: 'all IO goes through @terminal/sdk — API-05' },
        { name: 'EventSource', message: 'all IO goes through @terminal/sdk — API-05' },
      ],
      // `no-restricted-globals` matches a BARE identifier only, so it never sees `window.fetch()`,
      // `globalThis.fetch()` or `new self.WebSocket()`. That is the whole boundary written as a
      // rule people are told to trust, with a hole in it — and a guard nobody can rely on is worse
      // than no guard, because the reviewer stops looking. WP-12's audit found it while confirming
      // there is currently no breach to find. These selectors close the qualified forms.
      'no-restricted-syntax': [
        'error',
        ...['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'].flatMap((api) =>
          ['window', 'globalThis', 'self', 'top', 'parent'].map((host) => ({
            selector: `MemberExpression[object.name='${host}'][property.name='${api}']`,
            message: `all IO goes through @terminal/sdk — API-05 (${host}.${api} is the same call as a bare ${api})`,
          })),
        ),
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'inject a Clock — ARCHITECTURE L49' },
        { name: 'fetch', message: 'packages/core performs no IO — ARCHITECTURE L120' },
        { name: 'WebSocket', message: 'packages/core performs no IO — ARCHITECTURE L120' },
        { name: 'performance', message: 'inject a Clock — ARCHITECTURE L49' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'inject a Clock — ARCHITECTURE L49' },
        { object: 'Math', property: 'random', message: 'inject a seeded PRNG — QA-02' },
      ],
    },
  },

  // ── Tests, configs and generated barrels ────────────────────────────────────────────────────
  // `packages/*/test/**` is outside every boundary zone by construction (the zones above only
  // match `packages/*/src/**`); this block only relaxes the typed-lint strictness a harness needs.
  {
    files: ['packages/*/test/**/*.{ts,tsx}', 'packages/*/*.config.ts', '*.config.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: [
      'packages/core/src/functions/manifests/index.ts',
      'packages/core/src/fields/defs/index.ts',
      'packages/sdk/src/wire/rest/index.ts',
      'packages/server/src/functions/index.ts',
      'packages/server/src/ingest/jobs/index.ts',
      'packages/server/src/http/routes/index.ts',
      'packages/web/src/screens/index.ts',
    ],
    rules: {
      // GENERATED by scripts/gen-function-index.ts — never hand-edited (WORKPLAN §1.10).
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
);
