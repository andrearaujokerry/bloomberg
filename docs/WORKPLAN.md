# WORKPLAN — implementation as work packages for parallel agents

This is the build order for the terminal described in [BRIEF.md](./BRIEF.md),
[ARCHITECTURE.md](./ARCHITECTURE.md), [DATA_MODEL.md](./DATA_MODEL.md), [API.md](./API.md),
[FUNCTIONS.md](./FUNCTIONS.md) and `docs/parts/PROVIDERS.{a,b}.md`. It turns those documents into
**WP-01, a single blocking scaffold**, and **fourteen work packages (WP-02 … WP-15) that run
concurrently afterwards with mutually exclusive file ownership**.

Every name used below — table, column, enum, route, WebSocket message, exported type, file path —
comes from [CONTRACTS.md](./CONTRACTS.md), the mechanical digest of the four spine documents.
Anything this plan needs that CONTRACTS.md does not define is listed in §18 "Additions required"
and nowhere else.

---

## 0. How an agent uses this plan

1. Read **this file** and **CONTRACTS.md** in full. They are the only two documents you read whole.
   CONTRACTS.md is a mechanical digest, and three of its sections are known to be incomplete or
   ambiguous (§18.2): **§2.1 Routes** (11 of ~106 — verify routes against API.md §5 L392-838),
   **§2.2 WebSocket message types** (9 of 20 — API.md §6.2 L868-915 is normative), and the duplicated
   function framework in **§3.1 vs §4.1** — where **FUNCTIONS.md is normative** for
   `FunctionManifest`, `defineFunction`, `Payload`/`PayloadMeta`, the CSV and screen types and
   `ResolveContext`; ARCHITECTURE's copies are informative. Never build one of those three from the
   digest alone.
2. Read the **specific doc sections your package cites** with a bounded read
   (`Read(file, offset=L, limit=n)`) or a `grep` for the identifier. Never read
   ARCHITECTURE.md, DATA_MODEL.md, API.md, FUNCTIONS.md, FIXTURES.md or PROVIDERS.*.md whole.
3. Touch **only the paths your package owns** (§17 is the authoritative path → WP index).
   If you believe you must edit a file another package owns, stop and raise an
   *additions-required* note (§0.4) instead.
4. Your package is done when: `npm run lint && npm run typecheck && npm test` pass from the repo
   root, every acceptance test named in your package exists and passes, and `npm run db:migrate &&
   npm run db:seed` still succeed from an empty `bloomberg_dev`.

### 0.1 Ownership rules

- **One writer per file.** No two packages list the same path. Directory globs in §17 are disjoint.
- **Shared registries are generated, never hand-edited.** `core/src/functions/manifests/index.ts`,
  `server/src/functions/index.ts`, `server/src/ingest/jobs/index.ts`,
  `server/src/http/routes/index.ts`, `web/src/screens/index.ts`, `core/src/fields/defs/index.ts`
  and `sdk/src/fields/fields.json` are written by `scripts/gen-function-index.ts` /
  `scripts/gen-fields.ts` from directory listings (ARCHITECTURE L90-92). A package adds a file to
  the directory and runs `npm run gen:functions` / `npm run gen:fields`; it never edits the barrel.
  Generated barrels are committed and CI re-runs the generators and fails on a diff.
- **Transferred files.** A few files are *created* by WP-01 as compiling stubs so the scaffold
  builds, then have exactly one owner for the rest of the project. They are marked
  `created by WP-01 → owned by WP-nn` in §17. After WP-01 merges, WP-01 never touches them again.
- **The field dictionary** is a directory of per-class modules (`core/src/fields/defs/*.ts`, §18.1)
  with a glob-generated barrel, so that adding `REVENUE` (WP-10) and `RATE_P25` (WP-11) are not the
  same file edit.
- **Migrations are frozen after WP-01.** `drizzle/migrations/0001…0016` are transcribed once from
  DATA_MODEL.md. A package that needs a new column adds `drizzle/migrations/0017_<wp>_<topic>.sql`
  *and* an additions-required note; it never edits 0001-0016 or another package's 0017+ file.

### 0.2 Test path conventions

**`docs/TESTING.md` exists and is normative for test file paths, names and the harness contract.**
Where this plan and TESTING.md name the same test differently, TESTING.md wins and this plan's
acceptance table is the one that gets corrected. The conventions below — attested by ARCHITECTURE L206,
L352-355, L392, L398-409, the FUNCTIONS.md §8 table (L1309-1332) and TESTING §2-§4 — are the shape every
*new* path follows:

| Kind | Path | Runner |
| --- | --- | --- |
| core unit | `packages/core/test/<area>/<name>.test.ts` | vitest, no IO, `VirtualClock` |
| core fuzz (QA-05) | `packages/core/test/<area>/<name>.fuzz.test.ts` | vitest, 100 k cases, seeded |
| core bench | `packages/core/test/<area>/<name>.bench.ts` | `vitest bench` |
| sdk contract | `packages/sdk/test/<name>.test.ts` | vitest, schema round-trip of API.md examples |
| server unit | `packages/server/test/unit/<area>/<name>.test.ts` | vitest, no DB |
| server integration | `packages/server/test/integration/<area>/<name>.test.ts` | vitest against `bloomberg_test`, one transaction per test via `server/src/test/db.ts` |
| provider replay (QA-02) | `packages/server/test/replay/<name>.test.ts` | vitest, `PROVIDER_MODE=replay` |
| parity (API-05) | `packages/server/test/parity/<name>.test.ts` | vitest, JSON = CSV = WS snapshot |
| web component | `packages/web/test/<area>/<name>.test.tsx` | vitest + jsdom + RTL |
| e2e | `packages/e2e/tests/<name>.spec.ts` | Playwright, channel `chrome` |

Three consequences, because TESTING.md names files this plan either spells differently or leaves
unowned:

1. **WP-02's analytics files take TESTING §7's names**, which are flat under
   `packages/core/test/analytics/`: `bsm.test.ts`, `bond.price.test.ts`, `bond.risk.test.ts`,
   `bond.solver.test.ts` (a solver test this plan omitted entirely — Newton convergence and the
   bisection fallback, TESTING §7.5), `daycount.test.ts`, `bill.test.ts`, `curve.bootstrap.test.ts`,
   `stats.test.ts` — not `analytics/options/bsm.test.ts`, `analytics/bond/price.test.ts`,
   `daycount/conventions.test.ts`, `analytics/stats/index.test.ts`,
   `analytics/curve/bootstrap.test.ts`. `packages/core/test/adjust/corporateActions.test.ts` already
   agrees.
2. **Files TESTING.md names that no work package claimed** are assigned here:
   `packages/server/test/integration/pit.fundamentals.test.ts` and `…/curves.build.test.ts` → **WP-04**
   (`…/bitemporal.test.ts` is WP-01's, §1.11); `…/functions/HP.adjust.test.ts` → **WP-09**;
   `…/functions/YAS.golden.test.ts` → **WP-11**;
   `packages/server/test/replay/{requestKey,manifest,import,normalisers,no-network}.test.ts` →
   **WP-05**; `…/replay/{sessions,determinism}.test.ts` → **WP-15**. They are in §17 under those
   owners.
3. Three of those sit directly under `test/integration/` rather than in an `<area>/` subdirectory.
   That is TESTING.md's spelling and it stands; the `<area>/` convention above governs new files.

`npm test` runs every project declared in the root `vitest.config.ts` (`test.projects`, TESTING.md §2.1) offline (`PROVIDER_MODE=replay`) and must
never touch the network. `npm run test:live` is the only opt-in to real providers.

### 0.3 Definition of "acceptance test"

A named test file that (a) exists at the path given, (b) asserts against a contract in
CONTRACTS.md or a recorded fixture — never against the implementation's own output — and (c) fails
if the package is reverted. Golden-file tests write their expectation into
`fixtures/golden/**` or `fixtures/providers/normalised/**` and diff it; a golden is regenerated
only with `UPDATE_GOLDENS=1` and the diff is reviewed.

### 0.4 Additions-required protocol

When a package needs a table, column, route, enum value, field id, dependency or type that
CONTRACTS.md does not list: append an entry to §18 of this file (the one place packages may edit a
shared file — append-only, at the end of the section, signed with the WP id), implement it in a
file your package owns, and add the migration as `0017_<wp>_<topic>.sql` if it is DDL. Never
silently invent a name.

### 0.5 Requirement IDs

Cite the requirement id inline in code comments and test names, exactly as BRIEF.md and
REQUIREMENTS.md write them (`REF-03`, `FEED-05`, `BUS-03`, `ENTL-05`, `TERM-12`, `ANAL-08`,
`QA-02`, `STOR-07`, …). `docs/TRACEABILITY.md` (WP-15) is generated from those citations.

---

## 1. WP-01 — Scaffold, schema, contracts and toolchain

**Blocking.** Nothing else starts until this is merged and green. One agent, no parallelism inside.

**Goal:** `npm install && npm run db:migrate && npm run db:seed && npm test` passes on a clean
checkout against a local Postgres 14, with placeholder tests, and every other package can start by
writing files into directories that already compile.

### 1.1 Root files

| Path | Content |
| --- | --- |
| `package.json` | `"name":"terminal"`, `"private":true`, `"type":"module"`, `"workspaces":["packages/*"]`, `"engines":{"node":">=22.19"}`. Scripts: `dev` (concurrent `server:dev` + `web:dev`), `build`, `test` (`vitest run`), `test:live` (`PROVIDER_MODE=live vitest run`), `lint` (`eslint .`), `typecheck` (`tsc -b`), `db:migrate`, `db:seed`, `db:reset`, `gen:functions`, `gen:fields`, `fixtures:record`, `fixtures:import`, `replay:run`, `replay:diff` (ARCHITECTURE L83-85) |
| `package-lock.json` | committed; it is the exact version pin behind every range below |
| `tsconfig.base.json` | `"strict":true`, `"module":"NodeNext"`, `"moduleResolution":"NodeNext"`, `"target":"ES2022"`, `"composite":true`, `"declaration":true`, `"declarationMap":true`, `"sourceMap":true`, `"noUncheckedIndexedAccess":true`, `"exactOptionalPropertyTypes":true`, `"verbatimModuleSyntax":true`, `paths` for `@terminal/{core,sdk,server,web}` (ARCHITECTURE L86) |
| `tsconfig.json` | solution file: `"files":[]`, `references` to the five packages |
| `eslint.config.js` | flat config, §1.2 |
| `.prettierrc.json` | `{"printWidth":100,"singleQuote":true,"semi":true,"trailingComma":"all","arrowParens":"always"}`; `.prettierignore` excludes `drizzle/migrations`, `fixtures`, generated barrels |
| `vitest.config.ts` | root config declaring `test.projects` — the five projects of TESTING.md §2.1: `core`, `sdk`, `server-unit`, `server-int`, `web`. `core`/`sdk`/`server-*` environment `node`, `web` environment `jsdom`; `server-int` sets `DATABASE_URL=$DATABASE_URL_TEST` and `PROVIDER_MODE=replay` and runs `forks`; `e2e` excluded. **Not `vitest.workspace.ts`**: the workspace file was deprecated in Vitest 3.2 in favour of `test.projects` and is gone in v4/v5, and the pinned runner is `vitest ^5.0.0` — a `vitest.workspace.ts` would run zero projects. ARCHITECTURE L88 still names the old file; TESTING.md §2.1 is normative here |
| `.env.example` | `DATABASE_URL=postgres://localhost:5432/bloomberg_dev`, `DATABASE_URL_TEST=postgres://localhost:5432/bloomberg_test`, `PORT=8080`, `PROVIDER_MODE=replay`, `REPLAY_DIR=./fixtures/providers`, `SEC_USER_AGENT="Terminal Clone dev (andre.araujo.kerry@gmail.com)"`, `OPENFIGI_API_KEY=`, `FRED_API_KEY=`, `BLS_API_KEY=`, `FINRA_API_KEY=`, `DATABASE_URL_MAINT=postgres://localhost:5432/bloomberg_dev` (the `terminal_maint` connection of DATA_MODEL §15.d.1), `SESSION_SECRET=dev-only-change-me`, `CONFLATION_MS_DEFAULT=250`, `LOG_LEVEL=info` (mirrors `server/src/config.ts`, ARCHITECTURE L248-250) |
| `.gitignore` | `node_modules`, `dist`, `.env`, `coverage`, `playwright-report`, `test-results` |

### 1.2 `eslint.config.js` — the structural rules (ARCHITECTURE L59-77)

Flat config, ESLint 9. Three rule groups that make API-05 structural rather than aspirational:

1. `import/no-restricted-paths` encoding the dependency table verbatim:
   `packages/core` may import `zod` only — zones forbid `packages/{sdk,server,web}/**`,
   `node:*`, `pg`, `fastify`, `ws`, `react`;
   `packages/sdk` may import `@terminal/core` + `zod`, never `packages/{server,web}/**`;
   `packages/server` may import `core`, `sdk`, `fastify`, `ws`, `pg`, `drizzle-orm`, `pino`,
   `undici`, never `react` or `packages/web/**`;
   `packages/web` may import `core`, `sdk`, `react`, `react-dom`, `zustand`, never `pg`,
   `fastify`, `packages/server/**`;
   `packages/e2e` may import `@playwright/test` only, never any package source.
2. `no-restricted-globals` for `fetch`, `WebSocket`, `XMLHttpRequest` in `packages/web/src/**`
   (message: "all IO goes through @terminal/sdk — API-05"), and for `Date`/`Date.now` in
   `packages/core/src/**` (message: "inject a Clock — ARCHITECTURE L49").
   **Every zone in groups 1 and 2 is scoped to `packages/*/src/**`, never to a whole package.** Tests
   are outside them: `packages/*/test/**` may use `node:fs` (WP-02's `analytics/golden.test.ts` reads
   `fixtures/golden/analytics/**` from disk), `Date`, and whatever else a harness needs. A zone that
   covered `packages/core/**` would make WP-02's own acceptance tests unlintable.
3. `@typescript-eslint` type-checked preset with `no-floating-promises`, `no-misused-promises`,
   `consistent-type-imports`; `no-restricted-syntax` banning `process.env` outside
   `server/src/config.ts` and `scripts/**`.

### 1.3 Package manifests and dependency versions

Five `package.json` + five `tsconfig.json` with project `references` (`sdk`→`core`;
`server`→`core`,`sdk`; `web`→`core`,`sdk`; `e2e`→none). Ranges below; `package-lock.json` is the
exact pin.

- `packages/core` (`@terminal/core`): deps `zod ^4.0.0`. `tsconfig.json` `lib:["ES2022"]`, **no**
  `"DOM"`, **no** `@types/node` — the compiler enforces "no IO" (ARCHITECTURE L120).
- `packages/sdk` (`@terminal/sdk`): deps `zod ^4.0.0`; peer `@terminal/core`; `lib:["ES2022","DOM"]`.
- `packages/server` (`@terminal/server`): deps `fastify ^5.12.0`, `@fastify/cookie ^11.0.0`,
  `ws ^8.18.0`, `pg ^8.13.0`, `drizzle-orm ^0.45.0`, `zod ^4.0.0`, `pino ^9.5.0`,
  `undici ^7.0.0`, `@terminal/core`, `@terminal/sdk`; dev `drizzle-kit ^0.31.0`,
  `@types/node ^22.0.0`, `@types/pg ^8.11.0`, `@types/ws ^8.5.0`, `tsx ^4.19.0`, `pino-pretty ^13.0.0`.
- `packages/web` (`@terminal/web`): deps `react ^19.3.0`, `react-dom ^19.3.0`, `zustand ^5.0.0`,
  `@terminal/core`, `@terminal/sdk`; dev `vite ^8.0.0`, `@vitejs/plugin-react ^6.1.0`,
  `jsdom ^26.0.0`, `canvas ^3.0.0`, `@testing-library/react ^16.1.0`,
  `@testing-library/user-event ^14.5.0`, `@testing-library/jest-dom ^6.6.0`.
  Two pins carry a reason. **`@vitejs/plugin-react ^6.1.0`**, not `^5`: only 5.2.0 declares `vite ^8`
  support (5.0.x/5.1.x peer-declare `^4.2 || ^5 || ^6 || ^7`) and v6 is the vite-8-native line
  (peer `vite ^8.0.0`); since `package-lock.json` is the pin behind every range, a lock resolved on an
  older 5.x leaves the dev server and the jsdom transform unusable after `npm ci`. **`canvas ^3.0.0`**:
  jsdom implements no 2-D context of its own — `HTMLCanvasElement.getContext('2d')` returns `null`
  unless jsdom's optional peer `canvas` is installed — so without it every WP-14 pixel golden
  (`chart/renderer.test.ts`, `chart.bench.ts`, `streaming.test.ts`) throws on its first `getContext`
  call. It is registered in the `web` project's `setup.tsx`. If a CI image cannot build the native
  module, the fallback is to move the pixel goldens to `packages/e2e` (Playwright, channel `chrome`,
  which is installed) and leave WP-14's vitest files on the pure geometry modules — but that is a
  deliberate re-assignment, not a silent skip.
  Node engines: `>=22.19` as declared in §1.1 satisfies vitest 5's `^22.12 || ^24 || >=26`.
- `packages/e2e` (`@terminal/e2e`): dev `@playwright/test ^1.63.0`.
- root dev: `typescript ^5.9.0`, `vitest ^5.0.0`, `@vitest/coverage-v8 ^5.0.0`, `eslint ^9.15.0`,
  `typescript-eslint ^8.15.0`, `eslint-plugin-import ^2.31.0`, `prettier ^3.4.0`,
  `npm-run-all2 ^7.0.0`.

WebAuthn (SEC-02) has no library decision in the spine documents — see §18.9.

### 1.4 SQL migrations — transcribed from DATA_MODEL.md

`packages/server/drizzle.config.ts` (`out:'./drizzle/migrations'`, `dialect:'postgresql'`,
`schema:'./src/db/schema'`) plus sixteen committed `.sql` files. Transcribe each from the cited
DATA_MODEL.md range — bounded reads, one migration at a time. Every object listed in CONTRACTS §1.2
and §1.3 must exist afterwards; nothing else may.

**Filenames are DATA_MODEL.md's, verbatim.** Each is the `-- migration: <name>.sql` marker inside that
DDL block (and the same name in DATA_MODEL's own table at L24-39), not a name derived from the CONTRACTS
§1.4 section headings — those headings are prose titles. Drizzle records migrations in its journal by
exact filename, so a single divergent name produces a second, incompatible `drizzle/migrations` folder on
the next machine that runs `npm run db:migrate`.

| File | DATA_MODEL.md range | Objects (CONTRACTS §1.2/§1.3) |
| --- | --- | --- |
| `0001_extensions_enums.sql` | L61-244 | `CREATE EXTENSION pg_trgm, btree_gist, pgcrypto, uuid-ossp`; enums `asset_class, market_sector, id_scheme, tier, usage_type, field_class, entl_decision, ca_type, ca_status, entity_kind, session_state`; `tier_rank`, `bt_as_of`, `bt_guard_update`, `bt_close_tx`, `set_updated_at`, `app_user_id`, `app_firm_id`, `app_role` |
| `0002_provenance_licence.sql` | L245-342 | `provenance`, `licence_registry` (+3 constraints), `field_licence`, `assert_source_known`, triggers `licence_registry_bt_guard`, `provenance_source_known`, `field_licence_source_known` |
| `0003_security_master.sql` | L343-547 | `issuers`, `issues`, `instruments`, `listings`, `md_lines`, `identifiers` (+ valid/tx/bt-excl constraints each, `md_lines_symbol_excl`), views `issuers_now … identifiers_now`, six `*_bt_guard` triggers, `md_lines_source_known` |
| `0004_terms.sql` | L548-756 | `govt_terms`, `option_terms`, `future_terms`, `fund_terms`, `index_terms`, `fx_terms`, `rate_terms` + guards |
| `0005_calendars_classifications.sql` | L757-934 | `calendars`, `calendar_sessions`, `calendar_holidays`, `exchanges`, `classification_schemes`, `classification_codes`, `entity_classifications`, `indices`, `index_members`, `people`, `entity_relations`, `issuer_aliases` + guards/source triggers |
| `0006_corporate_actions.sql` | L935-1016 | `corporate_actions` (+ `ratio_chk`, `natural_excl`), `corporate_actions_bt_guard` |
| `0007_market_data.sql` | L1017-1225 | `bars_daily`, `bars_intraday`, `quote_ticks`, `option_quotes` (all `PARTITION BY RANGE`), `quote_snapshots`, `eod_snapshots`, `fx_rates`, `short_interest`, `etf_holdings`, `vol_surfaces` |
| `0008_fundamentals.sql` | L1226-1361 | `filings`, `xbrl_facts` (+ `period_chk`), `xbrl_frames`, `xbrl_concept_map`, `fin_statements` |
| `0009_econ_curves.sql` | L1362-1511 | `econ_releases`, `econ_series`, `econ_observations`, `rate_fixings`, `econ_release_events`, `fomc_meetings`, `curves`, `curve_points`, `curve_builds` + source triggers |
| `0010_news.sql` | L1512-1574 | `topics`, `news_items` (STORED `tsv`), `news_entity_links`, `news_items_source_known` |
| `0011_users_entitlements.sql` | L1575-1769 | `firms`, `users`, `user_credentials` (+ `shape` check), `sessions`, `api_keys`, `entitlement_grants`, `access_log` (partitioned), `usage_declarations`, `quota_limits`, `quota_counters`, `quota_instruments_seen` |
| `0012_workspace_portfolio.sql` | L1770-1947 | `workspaces`, `watchlists`, `watchlist_items` (+ `kind` check), `portfolios`, `portfolio_imports`, `positions`, `lots`, `chart_annotations`, `saved_searches`, `alerts`, `alert_events` + `*_updated` triggers |
| `0013_messaging.sql` | L1948-2056 | `rooms`, `room_members`, `messages`, `message_reads`, `legal_holds`, `surveillance_lexicon`, `surveillance_hits`, `message_reviews` |
| `0014_ops.sql` | L2057-2196 | `usage_events` (partitioned), `help_tickets`, `ingest_runs`, `dq_events`, `data_exceptions`, `status_incidents`, `schema_meta`, `config_versions`, `bump_config_version` + four bump triggers, `provenance.run_id` FK |
| `0015_roles_rls_worm.sql` | L2197-2372 | application role + grants, RLS policies (PORT-07, SEC-05/06), `worm_block` + five WORM triggers, `messages_chain` + `messages_chain_trg`, `is_room_member`, `room_has_firm` |
| `0016_partitions_initial.sql` | L2373-2443 | generated initial partitions for `bars_daily`, `bars_intraday`, `quote_ticks`, `option_quotes`, `access_log`, `usage_events` + default partitions |

`npm run db:migrate` = `tsx scripts/migrate.ts`: applies every unapplied file in lexical order
inside one transaction each, records it in `schema_meta`, and is idempotent.

### 1.5 Drizzle schema mirror

`packages/server/src/db/schema/*.ts`, one file per domain, mirroring the migrations exactly
(ARCHITECTURE L253-256): `provenance.ts`, `reference.ts`, `terms.ts`, `calendars.ts`,
`timeseries.ts`, `corporateActions.ts`, `fundamentals.ts`, `econ.ts`, `curves.ts`, `news.ts`,
`users.ts`, `entitlements.ts`, `workspace.ts`, `portfolio.ts`, `messaging.ts`, `alerts.ts`,
`ops.ts`, plus `index.ts` (hand-written barrel re-exporting all seventeen — this file is owned by
WP-01 forever and changes only when a migration does). Enums declared once with
`pgEnum` in `schema/enums.ts`. Acceptance: `packages/server/test/integration/db/schema-drift.test.ts` — parity between the applied
database and the mirror's `getTableConfig` metadata, with an allowlist for the objects Drizzle cannot
model (§1.11). `drizzle-kit check` is **not** used: it validates a generated migration journal, which
these hand-written migrations do not have.

### 1.6 Core modules shipped by WP-01

These are the contracts every other package imports. Complete implementations, not stubs.

- `core/src/index.ts` — barrel.
- `core/src/clock.ts` — `interface Clock { now(): number }`, `SystemClock`, `VirtualClock`
  (ARCHITECTURE L123).
- `core/src/types/instrument.ts` — `AssetClass`, `MarketSector`, `IdScheme`, `Bitemporal`,
  `Issuer`, `Issue`, `Instrument`, `Listing`, `MdLine`, `SecurityRef`, `ResolvedRef`
  (ARCHITECTURE L418-489).
- `core/src/types/quote.ts` — `Tier`, `SessionState`, `ValueState`, `Timestamps3`, `ProvRef`,
  `QuoteFields`, `QuoteFieldId`, `LineState`, `QuoteState`, `NormalisedUpdate`
  (ARCHITECTURE L493-556).
- `core/src/types/fields.ts` — `FieldId`, `FieldClass`, `FieldDef`, `FieldValue` (API.md L1064).
- `core/src/types/provenance.ts` — `ProvenanceRecord`, `LicenceEntry`.
- `core/src/types/entitlement.ts` — `UsageType`, `ReasonCode`, `EntitlementRequest`,
  `FieldDecision`, `EntitlementDecision` (ARCHITECTURE L1142-1148).
- `core/src/types/function.ts` — `Payload<T>`, `PayloadMeta`, `UnavailableReason`, `ValueCell`,
  `BasePayload` (FUNCTIONS.md L158-211).
- `core/src/types/bars.ts` — `Bar`, `BarInterval`, `AdjustPolicy`.
- `core/src/hash/sha256.ts` — **addition (§18)**: a dependency-free, synchronous, pure-TypeScript
  SHA-256, `export function sha256Hex(input: string | Uint8Array): string`, plus
  `core/src/hash/canonicalJson.ts`, `export function canonicalJson(v: unknown): string` (object keys
  sorted, no whitespace, numbers in shortest round-trip form, `undefined` members dropped). This exists
  because ANAL-08's `inputsHash char(64)` is computed by `defineEngine` in `packages/core`, whose
  package has `zod` as its only dependency, no `@types/node`, `lib:["ES2022"]` with no DOM, and an ESLint
  zone that forbids `node:*`: `node:crypto` is banned and untyped there, and `globalThis.crypto.subtle`
  needs DOM/Node lib types and is async. `inputsHash = sha256Hex(canonicalJson(inputs))`, and it is the
  same function on every side, which is what makes `vol_surfaces.inputs_hash`,
  `curve_builds.inputs_hash` and `fin_statements.inputs_hash` comparable across processes. (The
  alternative — injecting a `Hasher` port the way `Clock` is injected — was rejected: a hash that varies
  by host makes `curve_builds`' uniqueness key meaningless.) `core/test/hash/sha256.test.ts` checks the
  NIST vectors and the empty string.
- `core/src/functions/manifest.ts` — `FunctionManifest`, `ParamGrammar`, `ArgType`, `LiveSpec`,
  `CsvColumn`, `CsvDocument`, `CsvSpec`, `HelpSpec`, `KeyBinding`, `defineFunction`, `ParamsOf`,
  `PayloadOf` (FUNCTIONS.md L50-140, read L50-157).
- `core/src/functions/registry.ts` — `FunctionRegistry` class: code/alias lookup, `byTier`,
  `applicable(assetClass)`, duplicate detection (FUNCTIONS.md L502-538).
- `core/src/functions/csv.ts` — `toCsv(manifest, payload, params, ctx)` and `writeCsv(doc, headerLines)`:
  RFC 4180, CRLF, UTF-8 no BOM, `#` attribution comment lines first (FUNCTIONS.md L474-501, API.md §9 L1161).
- `core/src/fields/defs/*.ts` + generated `defs/index.ts` + `core/src/fields/dictionary.ts`
  (the assembled dictionary, API-07) and `core/src/fields/format.ts` (`format(fieldId, value, opts)`,
  the only formatter: px/pct/bp/int/ccy/date/datetime/text/shares). WP-01 seeds `defs/` with every
  field id in CONTRACTS §4.3, split by `field_class`; each class file then has a single later owner
  (§18.1).

### 1.7 SDK shipped by WP-01

- `sdk/src/wire/envelope.ts` — `ErrorEnvelope`, `PayloadMeta`, `AsOf`, `ProvenanceRef` zod schemas
  (API.md §2 L132-197, §3 L198-288).
- `sdk/src/wire/rest/<group>.ts` + a generated `sdk/src/wire/rest/index.ts` barrel — zod
  request/response for **every** route in the API.md route table (`Rest.<Group>.<Route>`), transcribed
  from API.md §1.3 (the 12 auth routes), §5.1-5.15 L392-838 (the ~90 rows of the markdown route table,
  including multi-method rows written `GET / PUT / DELETE`) and §9 (the five export endpoints), read in
  bounded chunks of one §5.x subsection at a time.
  **Do not enumerate routes from CONTRACTS §2.1.** That digest lists 11 routes — the ones that happened
  to sit inside fenced code blocks — out of the ~106 paths API.md declares; `GET /ref/resolve`,
  `POST /functions/:code/run`, `GET /universe/snapshot` and some ninety others are missing from it
  (§18 records this).
  One file per route group, matching the §17 route-file split so that one WP owns each:
  `auth, reference, search, functions, data, fields, news, workspaces, watchlists, portfolios, messages,
  alerts, help, usage, admin, status`. The group file is owned by the WP that owns the matching
  `server/src/http/routes/<group>.ts`: WP-01 writes them all first (that is this deliverable), and
  afterwards WP-07 owns `auth`/`usage`/`admin`, WP-08 owns `data`/`functions`/`fields`/`reference`/
  `search`/`status`/`workspaces`, WP-09 owns `news`/`messages`/`alerts`/`watchlists`/`help`, WP-10 owns
  `portfolios`. A single `wire/rest.ts` owned by WP-01 forever would force four packages to edit one
  file, violating §0.1 one-writer-per-file. `rest/index.ts` is generated by
  `scripts/gen-function-index.ts` from `sdk/src/wire/rest/*.ts` minus `index.ts`.
- `sdk/src/wire/ws.ts` — `ClientMsg`/`ServerMsg` discriminated unions **transcribed verbatim from
  API.md §6.2 L868-915** (a bounded read of exactly that range; it is itself verbatim from
  ARCHITECTURE §6.4), plus the `SubjectId` regex `^(q|l|b1m|oc|c|r|e|n|alerts|room|sys):[A-Za-z0-9_.:-]+$`
  and the close-code table of API.md §6.7 L1016-1027 (`1000`, `1001`, `4000 IDLE`, `4001 AUTH_REQUIRED`,
  `4002 PROTOCOL_ERROR`, `4003 SESSION_SUPERSEDED`, `4008 SLOW_CONSUMER`, `4010 PROTOCOL_VERSION`,
  `4011 SUBSCRIPTION_LIMIT`, `4029 RATE_LIMITED`) as a named const.
  **Do not build this from CONTRACTS §2.2.** That digest lists nine members; the union has twenty:
  `ClientMsg` = `hello, sub, unsub, resync, conflation, essential, ping`;
  `ServerMsg` = `welcome, subAck, snap, delta, status, batch, downgrade, resync, notice, alert, msg,
  err, pong, bye`. A schema built from the nine rejects every unsubscribe, resync, heartbeat, alert, room
  message and close frame, which breaks WP-06 (`ws/protocol.ts` encodes strictly through these schemas),
  WP-13 (`sub`/`unsub` batching, prev-chain resync) and WP-09 (`alerts:me`, `room:`) — silently, because
  the frames simply fail to parse. §18 records that CONTRACTS §2.2 is incomplete.
- `sdk/src/wire/dataRequest.ts` — the one `DataRequest`/`DataResponse` model (API.md §4 L289-391).
- `sdk/src/wire/reasonCodes.ts` — `ReasonCode` mirroring `core/types/entitlement.ts`.
- `sdk/src/client/rest.ts` — `RestClient`, `TerminalApiError`, `ClientOptions`, `TerminalClient`,
  `createClient()`: schema-driven fetch wrapper, `x-trace-id`, zod validation of responses, error
  envelope → typed errors, ETag cache for `/universe/snapshot` (API.md L1211-1282). Adding a route
  requires no edit here — it is driven by `wire/rest/*`.
- `sdk/src/fields/index.ts` (+ generated `fields.json`), `sdk/src/functions/index.ts`
  (registry re-export + `runFunction`), `sdk/src/index.ts`.
- Stubs created here, owned by **WP-13** afterwards: `sdk/src/client/ws.ts`,
  `client/subscriptions.ts`, `client/quoteCache.ts` — exported classes with the signatures of
  API.md L1286-1334 whose bodies throw `new Error('NOT_IMPLEMENTED: WP-13')`.

### 1.8 Server skeleton shipped by WP-01

- `server/src/config.ts` — zod env exactly as ARCHITECTURE L248-250, plus four keys that document
  elsewhere requires but that list omits, all `.optional()`: `BLS_API_KEY` and `FINRA_API_KEY` (named as
  `licence_registry.api_key_env` for `bls.timeseries` and `finra.shortInterest`, PROVIDERS.b §15 — unused
  in v1 because both tiers are keyless, but they must resolve or the registry row points at nothing) and
  `DATABASE_URL_MAINT` (§15.d.1). The only place `process.env` is read.
- `server/src/db/client.ts` — `pg.Pool` + drizzle, `withTx(fn)`, per-request
  `set_config('app.user_id'|'app.firm_id'|'app.role')` (DATA_MODEL §15.1). Plus a second, single-connection
  pool on `DATABASE_URL_MAINT` exposed as `withMaintTx(fn)`, connecting as `terminal_maint` — the role
  that owns the six partitioned parents (DATA_MODEL §15.d.1). `terminal_app` has USAGE on the schema and
  SELECT/INSERT only, so it can neither `CREATE` a partition nor `DROP` one; giving it ownership instead
  would also let it disable the WORM triggers on `access_log`/`usage_events`. Only `db/partitions.ts` and
  `retentionPurge` may use `withMaintTx`.
- `server/src/app.ts` — `buildApp(deps): FastifyInstance`: registers `http/trace.ts`,
  `http/errors.ts`, `@fastify/cookie`, the **generated** `http/routes/index.ts` barrel, and the WS
  gateway entry point. Frozen after WP-01: routes and the gateway are added by dropping files into
  the globbed directories.
- `server/src/index.ts` — process entry with the startup order of ARCHITECTURE §12.1 (L1221-1238).
- `server/src/http/trace.ts` (x-trace-id plugin, accept or mint UUID v4, child logger, response
  header), `server/src/http/errors.ts` (`AppError` → `ErrorEnvelope`), `server/src/http/routes/health.ts`
  — created here, owned by **WP-08** afterwards.
- `server/src/plant/tickerPlant.ts` and `server/src/ws/gateway.ts` — stub `buildPlant()` /
  `registerWsGateway()` that satisfy `app.ts`; owned by **WP-06** afterwards.
- `server/src/functions/runner.ts` — stub `runFunction()` throwing `NOT_IMPLEMENTED`; owned by
  **WP-08** afterwards.
- `server/src/providers/licences.ts` — the 33 `licence_registry` rows and the `field_licence`
  matrix, transcribed from PROVIDERS.b §15 (L1746-1799), including its three `retention_days` values
  (`cboe.quotes` 30, `cboe.options` 10, `yahoo.chart` 400, NULL everywhere else — the only input to
  partition drops, STOR-07). Every other write in the database is gated by `assert_source_known` on
  these rows, so they belong to the scaffold. **33 is the whole registry**: the `openfigi-search`
  capture on disk is recorded under `source_id 'openfigi.mapping'`, which PROVIDERS.b §6.2 states is
  the single licence row covering both `/v3/mapping` and `/v3/search`, so WP-05's OpenFIGI adapter
  never writes provenance for a source id that is not here. There is no `openfigi.search` row, no
  `openfigi.search` `ProviderId`, and DATA_MODEL §2's comment has been corrected to match.
- `server/src/test/db.ts`, `test/app.ts`, `test/clock.ts`, `test/fixtures.ts` — the harness every
  other package's integration tests use: transactional DB harness against `bloomberg_test`, app
  factory, `VirtualClock`, replay-fixture loader (ARCHITECTURE L352-353).
- `server/src/seed/index.ts` (the ordered seed runner) and `server/src/seed/licences.ts`
  (module 1 of DATA_MODEL §18 L2487). The other twelve seed modules are WP-15.

### 1.9 Web and e2e skeletons shipped by WP-01

`packages/web/index.html`, `vite.config.ts` (proxy `/api` → `:8080`, `/ws` → `ws://:8080`),
`src/main.tsx`, `src/App.tsx` (session gate + one `RestClient`; renders the shell entry point),
`src/theme/tokens.css`. `packages/e2e/playwright.config.ts` (channel `chrome`,
`baseURL http://localhost:5173`, `webServer` spawning the replay-mode server) and
`packages/e2e/fixtures/serverProcess.ts` (ARCHITECTURE L398-400).

### 1.10 Generators, fixtures importer, seed loader

- `scripts/gen-function-index.ts` — writes the six generated barrels. Every one is **GENERATED-only**:
  the script is WP-01's, the output files have no human owner and are never hand-edited (§0.1, §17).
  The globs are exact, because a naive directory listing would sweep in hand-written siblings —
  `server/src/functions/` also holds WP-08's `runner.ts`, `context.ts`, `resultCache.ts` and
  `export.ts`, which are not function modules:
  | Barrel | Glob |
  | --- | --- |
  | `core/src/functions/manifests/index.ts` | `core/src/functions/manifests/*.ts` minus `index.ts` |
  | `server/src/functions/index.ts` | `server/src/functions/*/resolve.ts` (**directories only** — one per function code) |
  | `web/src/screens/index.ts` | `web/src/screens/*/Screen.tsx` |
  | `server/src/ingest/jobs/index.ts` | `server/src/ingest/jobs/*.ts` minus `index.ts` |
  | `server/src/http/routes/index.ts` | `server/src/http/routes/*.ts` minus `index.ts` |
  | `sdk/src/wire/rest/index.ts` | `sdk/src/wire/rest/*.ts` minus `index.ts` |
  (§18.3 extends ARCHITECTURE L90 to the last three.)
- `scripts/gen-fields.ts` — validates `core/src/fields/defs/*.ts` (minus `index.ts`), writes the
  GENERATED `defs/index.ts` and `sdk/src/fields/fields.json`.
- `scripts/fixtures-import.ts` — registers `fixtures/providers/raw/*` (48 entries on disk) into
  `fixtures/providers/manifest.json` as `requestKey → {file, providerId, capturedAt, sha256, sourceTs}`
  using the §8.1 key `sha256(providerId|METHOD|url-sorted-query|sha256(body))`
  (PROVIDERS.a §3.2-3.4 L357-477, FIXTURES.md per-file entries).
- `scripts/fixtures-urls.ts` — the `FIXTURE_URLS` table mapping each raw file to the exact URL it
  was captured from (PROVIDERS.b §16.10: Bloomberg entries must record the post-redirect
  `www.bloomberg.com/feeds/…` form).
- `scripts/migrate.ts`, `scripts/seed.ts` (invokes `server/src/seed/index.ts`), `scripts/reset.ts`.

### 1.11 Acceptance tests (WP-01)

| Test | Proves |
| --- | --- |
| `packages/server/test/integration/db/migrate.test.ts` | migrate on an empty database creates every table, enum, view, trigger and function named in CONTRACTS §1.2/§1.3 — asserted by querying `information_schema` / `pg_trigger` / `pg_proc` against a checked-in list |
| `packages/server/test/integration/db/schema-drift.test.ts` | the Drizzle mirror matches the applied database: apply all sixteen migrations to `bloomberg_test`, then assert parity between `information_schema.columns` / `pg_indexes` and the mirror's own metadata (`getTableConfig(table)` per `db/schema/*`) — table set, column names, types, nullability and indexes — with a checked-in allowlist of objects Drizzle cannot model, which `migrate.test.ts` asserts against `pg_proc` / `pg_trigger` / `pg_constraint` / `pg_partitioned_table` instead. **Not `drizzle-kit check`**: that command checks the consistency of a *generated* migration history (journal + snapshots written by `drizzle-kit generate`), not schema drift, and these sixteen migrations are hand-transcribed SQL with no journal. An exact generate-based mirror is impossible in drizzle-orm 0.45 anyway — it cannot express `PARTITION BY RANGE`, `EXCLUDE USING gist … WHERE (tx_to='infinity')`, SQL functions (`bt_as_of`, `tier_rank`, `bt_close_tx`), triggers (`bt_guard_update`, `worm_block`, `messages_chain`, `assert_source_known`), the `*_now` views or the RLS policies — so any such diff is permanently non-empty. The allowlist is the explicit list of those objects |
| `packages/server/test/integration/bitemporal.test.ts` (the path DATA_MODEL §1.4 and TESTING §7.10 both name) | the worked acceptance query of DATA_MODEL §1.4 (L228-244) and TESTING §7.10 `bt.correction` (initial 2026-03-01 coupon 4.500, correction 2026-03-10 → 4.250, read at `known_at` 2026-03-05 → 4.500 and 2026-03-12 → 4.250 — both versions written in one transaction, which needs `VersionWrite.txFrom`): `bt_as_of` returns the row known at T1 and the corrected row known at T2 |
| `packages/server/test/integration/seed/licences.test.ts` | `db:seed` inserts 33 `licence_registry` rows and the `field_licence` matrix; every `ProviderId` in PROVIDERS.a §1.1 has a row (and `openfigi.search` is deliberately not a `ProviderId` — `/v3/search` records under `openfigi.mapping`); `retention_days` is non-null on exactly `cboe.quotes` (30), `cboe.options` (10) and `yahoo.chart` (400); `assert_source_known` rejects an unknown `source_id` |
| `packages/sdk/test/wire-roundtrip.test.ts` | every zod schema in `wire/**` parses the literal examples in API.md §6.8 (L1013-1039) and §12 (L1375-1442) and round-trips them |
| `packages/core/test/fields/dictionary.test.ts` | every field id in CONTRACTS §4.3 resolves; `gen:fields` output matches the committed `fields.json` |
| `packages/core/test/functions/csv.test.ts` | RFC 4180 quoting of commas/quotes/CRLF, `#` attribution header, CRLF line endings (FUNCTIONS.md §1.6) |
| `packages/web/test/no-direct-io.test.ts` | the built web bundle contains no `new WebSocket(` or `fetch(` outside the SDK chunk (ARCHITECTURE L74) |
| `packages/server/test/unit/config.test.ts` | `config.ts` rejects a missing `DATABASE_URL` and defaults `PORT`, `PROVIDER_MODE`, `CONFLATION_MS_DEFAULT` |
| `packages/e2e/tests/smoke.spec.ts` | Playwright starts the replay-mode server, loads `/`, sees the command line |

**Size:** XL — 8-12 agent-days. The migrations (§1.4) are more than half of it.

---

## 2. The fourteen concurrent packages

All of WP-02 … WP-15 start the moment WP-01 is merged. Cross-package dependencies below are
**interface** dependencies only (types and stub signatures exist from WP-01), except where an
explicit "blocks on" is stated. Every package imports from WP-01 at least: `@terminal/core`
types, `Clock`, the field dictionary and `format()`, and — for server packages —
`server/src/config.ts`, `db/client.ts` and `db/schema/*`.

---

### WP-02 — Core analytics, calendars, day counts and corporate-action adjustment

**Owns**

```
packages/core/src/calendars/**            calendar.ts nyse.ts sifma.ts usgovt.ts target2.ts fx.ts weekend.ts tenor.ts
packages/core/src/daycount/**             conventions.ts businessDay.ts
packages/core/src/analytics/**            engine.ts bill.ts bond/{price,risk,cashflows}.ts
                                          curve/{bootstrap,interp,curve}.ts swap/ois.ts
                                          options/{bsm,tree,mc}.ts vol/surface.ts wirp/policyPath.ts
                                          stats/index.ts portfolio/{exposure,attribution,risk}.ts
packages/core/src/adjust/corporateActions.ts
packages/core/src/fields/defs/analytic.ts
packages/core/src/fields/defs/derived.ts
fixtures/golden/analytics/**
packages/core/test/{calendars,daycount,analytics,adjust}/**
```

**Depends on:** WP-01 only, and **WP-02 stays self-contained on purpose**: it must not read WP-05's
replay store, because WP-11 waits on WP-02 and a hidden dependency on a day-5 package would make this
day-1 package a day-5 one. Every case in TESTING §7 is synthetic except `adjust.aapl.fixture`. So each
acceptance test below runs from a checked-in `fixtures/golden/analytics/**` file of literal
`{inputs, valuationTs, expected, source}` — where a case's numbers were *taken from* a recorded capture
(the Treasury bill sheet, the Cboe AAPL chain), WP-02 transcribes those inputs into the golden file and
records the capture's name in `source`; it does not open `fixtures/providers/raw/` and does not go
through `providers/replayStore.ts` (which §0.2/§1.10 make the only legitimate route to a raw capture).
The replay-backed variants of the same engines — parse the capture, feed the engine, compare — are
server-side integration tests owned by WP-04 (`data/historical`, corporate actions) and WP-11 (curves,
options chain). Nothing depends on WP-02 to *start*; WP-11 (Tier 3) and WP-10 (Tier 2 ratios) consume it
from day one through the `defineEngine` signature.

**Imports from WP-01:** `Clock`, `Bar`, `BarInterval`, `AdjustPolicy` (`core/types/bars.ts`),
`AssetClass`, `PayloadMeta['engines']` (`core/types/function.ts`), `FieldId`.

**Builds** (ARCHITECTURE L143-181 is the module list; read L156-181 bounded):

- `defineEngine(name, version, fn) → EngineResult { inputs, outputs, engine{name,version},
  valuationTs, inputsHash }` with the seeded xoshiro128\*\* PRNG — `inputsHash` is the `char(64)`
  written to `vol_surfaces.inputs_hash`, `fin_statements.inputs_hash` and `curve_builds.inputs_hash`
  (ANAL-08). Every engine below is wrapped in it; outputs echo their `Conventions` object (ANAL-07).
- Calendars `XNYS`, `XNAS`, `XCBO`, `SIFMA`, `USGOVT`, `FX_USD`, `TARGET2`, `XLON`, `WEEKEND`
  as **rule generators** 1990-2040 (Juneteenth from 2022, NYSE early closes, SIFMA recommended
  early closes) — WP-15's `seed/universe.ts` writes `calendars`, `calendar_sessions` and the
  ≈1,300 `calendar_holidays` rows from these generators (DATA_MODEL L2488), so the generator output
  is the contract: `calendar_id` values must match the `calendars.calendar_id` list verbatim.
- Day counts `ACT/ACT`, `ACT/360`, `ACT/365F`, `30/360`, `30E/360`, `ACT/ACT-ISDA` — the exact six
  strings of the `govt_terms.day_count` CHECK — plus `ACT_ACT_ICMA(freq)`; business-day conventions
  `following | modified_following | preceding | none` matching `govt_terms.business_day_conv`.
- Bills (≤182d and >182d), street-convention bond price↔yield, accrued, odd first/last coupons,
  cashflow schedules; duration/modified duration/convexity/DV01/key-rate durations (ANAL-01, YAS).
- Curve bootstrap (bills + par coupons → discount factors; OIS from SOFR fixings + par OIS),
  interpolation `linear_zero | log_linear_df | monotone_convex` (the `curves.default_interpolation`
  values), `Curve.df(t)/zero(t)/fwd(t1,t2)/snapshot()` whose snapshot is what
  `curve_builds.nodes` stores as `[{t, df, zero, fwd}]` (ANAL-02).
- SOFR OIS swap: annual fixed vs daily-compounded float, ACT/360, T+2, modified following, SIFMA;
  PV, par rate, DV01, annuity (SWPM).
- BSM with continuous `q`, Black-76, full greeks, implied vol by Brent+Newton (ANAL-03); CRR
  binomial and trinomial with American exercise; seeded antithetic + control-variate Monte Carlo.
- Chain → forward by put-call parity → SVI slice fit → arbitrage checks; the fit result is exactly
  `vol_surfaces.svi = {a,b,rho,m,sigma,rmse,n}` (ANAL-04).
- `wirp/policyPath.ts`: implied overnight path between FOMC dates from bill/OIS forwards, hike/cut
  probabilities in 25bp steps (BRIEF §2 — from the money-market curve, not fed-funds futures).
- Stats: simple/log returns, vol, corr, beta, OLS, drawdown, Sharpe/Sortino/IR (ANAL-07).
- Portfolio: exposure by sector/asset/currency, Brinson-Fachler attribution (PORT-03), ex-post
  tracking error, historical and parametric VaR, scenario shocks (PORT-04/05/06).
- `adjust/corporateActions.ts`: **`adjustmentFactors(actions: CaForAdjust[], closes: Array<{date, close}>,
  policy)`** → per-date cumulative price/volume factors, plus `applyAdjustment(bars, factors)` and
  `totalReturnIndex(...)`; policies `unadjusted | price | total_return` (REF-09). The three-argument form
  of DATA_MODEL §6.1 L1001 is the correct one and supersedes the two-argument `adjustmentFactors(actions,
  policy)` an earlier draft of this plan named: the dividend factor is `1 − amount / closeBeforeEx`, where
  `closeBeforeEx` is the **unadjusted close of the last session before the ex-date** (TESTING §7.9 pins
  `1 − 0.50/50.00 = 0.99`), which cannot be computed from `corporate_actions` rows alone. Consequence for
  WP-04: `data/historical.ts` must load bars over `[start − 1 session, end]` so the pre-ex close exists
  for the first action in the window (DATA_MODEL §6.1 read path); the extra session is dropped before the
  series is returned. Input rows are `corporate_actions` shaped — `ca_type`, `ex_date`,
  `ratio_new`/`ratio_old`, `amount` (DATA_MODEL §6.1 L982-1016, read bounded).

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/core/test/analytics/engine.test.ts` | `inputsHash` is stable across runs and process restarts; changing any input changes it (ANAL-08) |
| `packages/core/test/analytics/golden.test.ts` | QA-01: runs every `fixtures/golden/analytics/<engine>/<case>.json` `{inputs, valuationTs, expected}` and diffs to the documented tolerance |
| `packages/core/test/analytics/bill.test.ts` (TESTING §7.6) | discount ↔ price ↔ investment yield **both sides of 182 days**: `912797VE4` (`CUSIP_4WK`, 28 days — the simple branch) and `912797WA1` (`CUSIP_52WK`, 364 days — the quadratic investment-yield branch), matching TESTING §7.6's `bill.13wk` / `bill.52wk` pair. Not `912797WH6`: that is `CUSIP_17WK` (119 days), on the same side of 182 as the 4-week bill, so the pair would never exercise the >182-day formula. Inputs transcribed from `treasury-bills.xml` into the golden file |
| `packages/core/test/analytics/bond.price.test.ts` (TESTING §7.3) | price↔yield round-trip to 1e-9 for the seven on-the-run notes/bonds, their terms transcribed into `fixtures/golden/analytics/bond/onthe-run.json` (`source: 'treasury.yieldcurve capture + treasuries seed'`) so the case runs without the seed or the replay store; the TESTING §7.3 `bond.premium.short` case (`price = 101.903864`); accrued on a coupon date and the day before |
| `packages/core/test/analytics/bond.risk.test.ts` (TESTING §7.3) | duration/convexity/DV01 vs finite-difference reprice; key-rate durations sum to modified duration |
| `packages/core/test/analytics/bond.solver.test.ts` (TESTING §7.5) | the yield solver: Newton converges from a 2 % seed on the §7.5 case (`P(10.0) = 0.576774`, first Newton step ≈ −1111.4), and the bisection fallback is taken — and converges — on a cashflow set where Newton overshoots |
| `packages/core/test/analytics/curve.bootstrap.test.ts` (TESTING §7.7) | bootstrapped curve reprices its own inputs to zero error; `nodes` shape matches `curve_builds.nodes` |
| `packages/core/test/analytics/curve/interp.test.ts` | monotone-convex preserves monotonicity and positivity of forwards on a stressed input |
| `packages/core/test/analytics/swap/ois.test.ts` | par rate makes PV zero; DV01 vs finite difference; schedule honours SIFMA + modified following |
| `packages/core/test/analytics/bsm.test.ts` (TESTING §7.2) | the full TESTING §7.2 pin set on the synthetic case (S=K=100, r=0.05, q=0, σ=0.20, T=1): call 10.450584, put 5.573526, d1/d2, greeks vs finite difference, put-call parity, and the implied-vol round trip fed the engine's **own unrounded** output (feeding back the rounded 10.450584 lands 1.14e-8 off, so a `1e-8` tolerance on the pinned literal is unsatisfiable — TESTING §7.2 assertion 7). Chain-shaped strikes are transcribed from `cboe-options` into the golden file; the replay-backed chain test is WP-11's |
| `packages/core/test/analytics/options/tree.test.ts` | CRR → BSM convergence for European; American put ≥ European put |
| `packages/core/test/analytics/options/mc.test.ts` | seeded runs are bit-identical; antithetic + control variate inside the documented standard error of BSM |
| `packages/core/test/analytics/vol/surface.test.ts` | SVI fit on the AAPL chain slice transcribed into `fixtures/golden/analytics/vol/aapl-slice.json` (`source: 'cboe-options'`) has no calendar or butterfly arbitrage; `rmse` recorded; the fit result has exactly the `vol_surfaces.svi` shape. The fit over the *replayed* chain is WP-11's integration test |
| `packages/core/test/analytics/wirp/policyPath.test.ts` | probabilities per FOMC date sum to 1; a flat curve yields a zero-move path |
| `packages/core/test/analytics/stats.test.ts` (TESTING §7.8) | every statistic against a hand-checked series; `Conventions` echoed in outputs |
| `packages/core/test/analytics/portfolio/attribution.test.ts` | Brinson-Fachler allocation + selection + interaction = total active return |
| `packages/core/test/calendars/nyse.test.ts` | Juneteenth from 2022 only; early closes; `combine()` unions holidays (REF-06) |
| `packages/core/test/analytics/daycount.test.ts` (TESTING §7.4) | every convention against published worked examples; the six strings match the `govt_terms.day_count` CHECK list |
| `packages/core/test/adjust/corporateActions.test.ts` | the QA-01 golden is `fixtures/golden/analytics/adjust/split-dividend.json` — TESTING §7.9 case 1, fully self-contained (2:1 split factor 0.50, dividend factor `1 − 0.50/50.00 = 0.99`, combined 0.495, volume +11.111111 %/+10 %/−45 %) — asserting `price` vs `total_return` vs `unadjusted` (REF-09). The AAPL case is demoted to `fixtures/golden/analytics/adjust/aapl.json` with `source: 'published closes, external'`, because **no recorded fixture can produce it**: `yahoo-chart-events` is `range=5y interval=1d`, 1,255 daily bars from 2021-09-15 to 2026-09-15 with 20 dividends and **zero splits**, and `yahoo-chart-AAPL-max-1d.json` came back at `dataGranularity 3mo` — 169 quarterly bars from 1984-12-01 carrying the five splits (2:1 ×3, 7:1 2014-06-09, 4:1 2020-08-31) but no daily closes, so there is no 2020-08-28 close (499.23) and no pre-2014 close (645.57) anywhere on disk, and WP-15's rule that every seeded value cites a provenance row pointing at a fixture cannot hold for it. The split **dates and ratios** in that golden are cited from the quarterly `max` capture; the closes are cited as external published values. Re-capturing `query1.finance.yahoo.com/v8/finance/chart/AAPL?range=max&interval=1d&events=div%7Csplit` (a fourth missing capture, §18.14) would let the AAPL case be re-pointed at replay and promoted back to QA-01 |

**Size:** XL — 10-14 agent-days.

---

### WP-03 — Core symbology, command line, ranking and formula language

**Owns**

```
packages/core/src/ids/**                  figi.ts isin.ts cusip.ts sedol.ts occ.ts cik.ts securityRef.ts
packages/core/src/text/normName.ts
packages/core/src/command/**              tokenizer.ts grammar.ts parser.ts args.ts rank.ts index.ts sectors.ts
packages/core/src/search/types.ts
packages/core/src/formula/**              lexer.ts parser.ts ast.ts evaluator.ts
packages/core/src/fields/defs/reference.ts
packages/core/test/{ids,command,search,formula}/**
```

**Depends on:** WP-01 only.

**Imports from WP-01:** `SecurityRef`, `ResolvedRef`, `AssetClass`, `MarketSector`, `IdScheme`
(`core/types/instrument.ts`); `FunctionRegistry`, `FunctionManifest`, `ParamGrammar`, `ArgType`
(`core/functions/*`); `FieldId`.

**Builds** (FUNCTIONS.md §2 L603-856 and §3 L857-982 — read those two ranges bounded):

- Identifier codecs with check digits: FIGI format + check digit, ISIN Luhn over letter expansion,
  CUSIP mod-10 double-add-double, SEDOL 1-3-1-7-3-9, OCC parse/format for the Cboe form
  `AAPL260916C00245000` plus the padded OSI form (`option_terms.occ_symbol` is the Cboe form),
  `cik.ts` `pad`/`unpad` for the `data.sec.gov` vs `/Archives` mismatch (§18.6).
- `securityRef.ts`: parse/format `AAPL US Equity`, `SPX Index`, `EURUSD Curncy`, `912797VE4 Govt`,
  `T 4.25 08/15/36 Govt`, `AAPL 9/16/26 C245 Equity`, `/isin/…`, `/figi/…`, `/cusip/…`
  (ARCHITECTURE L140-142). Output is `SecurityRef`; resolution to an `instrument_id` is WP-04.
- `text/normName.ts`: the one name normaliser (case, punctuation, legal suffixes), used by
  `refdata/resolve.ts` and the news matcher (§18.7).
- `sectors.ts`: `MarketSector ↔ AssetClass` map over the eleven `market_sector` enum values and the
  ten `asset_class` values, plus sector aliases.
- `tokenize(raw) → Token[]`, `parse(raw, env) → ParsedCommand[]` (ranked, best first, never throws),
  `toRunRequest(cmd, env)`, `parseArgs(grammar, args, env)`. Types are fixed by CONTRACTS §4.1:
  `Token`, `CommandShape`, `CommandProblem`, `CommandSecurity`, `ParsedCommand`, `PanelContext`,
  `ParseEnv`. The grammar is `[SECURITY] [SECTOR] [FUNCTION] [ARGS] <GO>` with the TERM-03 context
  rules (function-only → panel's current security; security-only → panel's current function).
- `index.ts`: `UniverseIndex` — prefix arrays, word index, trigram fallback, MRU boost, built from
  the universe snapshot (the server side is WP-08's `search/snapshot.ts`).
- `rank.ts`: `rank(query, index, ctx, registry) → Candidate[]` (≤12, best first) over
  `Candidate { kind:'instrument'|'function'|'person'|'topic', score, … }` (FUNCTIONS.md §3.3 L918-957).
- Formula language (CHRT-07): lexer → parser → AST → evaluator supporting security refs,
  arithmetic, `RATIO`, `SPREAD`, `NORM`, `MA`. This is what `watchlists.columns[].formula` and
  `watchlist_items.formula` hold, so the accepted syntax is the column contract.

**Acceptance tests** (FUNCTIONS.md §8 rows are binding)

| File | Proves |
| --- | --- |
| `packages/core/test/command/parser.test.ts` | every worked example in FUNCTIONS.md §2.7 (L813-856) |
| `packages/core/test/command/parser.fuzz.test.ts` | QA-05: 100 k random strings (unicode, `<`, `/`, `=`) never throw; spans in bounds; `parse(raw)[0]` idempotent under re-parse of `insertText` |
| `packages/core/test/command/args.test.ts` | every `ArgType` syntax in §2.4 (L735-766) |
| `packages/core/test/command/rank.test.ts` | R0-R3 scoring terms, tie-breaks, the `W`/`CF`/`GP` cases |
| `packages/core/test/command/index.test.ts` | prefix bounds, word index, trigram fallback thresholds |
| `packages/core/test/command/command.bench.ts` | ≤4 ms p95 ranking on 45 k entries (NFR for TERM-02) |
| `packages/core/test/ids/checkdigits.test.ts` | FIGI/ISIN/CUSIP/SEDOL check digits over the identifiers in `sec-company-tickers.json` and `openfigi-map` |
| `packages/core/test/ids/occ.test.ts` | round-trip of 3,510 contract symbols from the `cboe-options` fixture |
| `packages/core/test/ids/securityRef.test.ts` | each of the eight ref forms parses and re-formats identically |
| `packages/core/test/ids/ids.fuzz.test.ts` | QA-05: codecs never throw on arbitrary input, reject malformed identifiers |
| `packages/core/test/formula/evaluator.test.ts` | `PX_LAST/PX_CLOSE_1D-1`, `RATIO(AAPL US Equity, SPX Index)`, `MA(PX_LAST,50)`, division by zero → `na` |
| `packages/core/test/formula/formula.fuzz.test.ts` | QA-05: parser never throws; unbalanced input yields a problem, not an exception |

**Size:** L — 7-9 agent-days.

---

### WP-04 — Security master, bitemporal writes, data services and reference ingest

**Owns**

```
packages/server/src/db/bitemporal.ts
packages/server/src/refdata/**            resolve.ts master.ts identifiers.ts terms.ts calendars.ts
                                          classifications.ts indexMembership.ts corporateActions.ts
                                          universe.ts newsDict.ts
packages/server/src/data/**               reference.ts historical.ts intraday.ts ticks.ts snapshot.ts
                                          fundamentals.ts econ.ts curves.ts rates.ts options.ts news.ts
                                          filings.ts holdings.ts portfolio.ts request.ts
packages/server/src/ingest/jobs/symbologyRefresh.ts
packages/server/src/ingest/jobs/universeSymbolBook.ts
packages/server/src/ingest/jobs/secNport.ts
packages/server/src/ingest/jobs/ssgaHoldings.ts
packages/server/src/ingest/jobs/shortInterest.ts
packages/server/test/integration/refdata/**
packages/server/test/integration/data/**
packages/server/test/unit/refdata/**
```

`data/*` is the **only** reader surface function resolvers may use (ARCHITECTURE L269). It is owned
here as one set so the `DataServices` interface (FUNCTIONS.md L278-350) has a single author; the
tier packages consume it and request additions through §18.

**Depends on:** WP-01. Interface-level on WP-02 (calendars for `refdata/calendars.ts`, adjustment
for `data/historical.ts`) and WP-03 (`securityRef`, `normName` for `refdata/resolve.ts`). Uses
WP-05's `ProviderRegistry` types for the five ingest jobs — **blocks on WP-05** for those five
files only; everything else proceeds immediately.

**Imports from WP-01:** `db/client.ts` (`withTx`), `db/schema/*`, `Instrument`/`Issue`/`Issuer`/
`Listing`/`MdLine`/`SecurityRef`/`ResolvedRef`, `AssetClass`, `IdScheme`, `AdjustPolicy`, `Clock`.

**Builds**

- `db/bitemporal.ts` — the normative write layer (ARCHITECTURE §4.3 L571-622, DATA_MODEL §1.3
  L177-227): `asOf(table, {validAt, knownAt})` → the `bt_as_of(...)` predicate, `current(table)`,
  `writeVersion<Row>(tx, table, w)`, `upsertVersion<Row>(tx, table, w)` over
  `VersionWrite { entityKey, validFrom, validTo?, data, provenanceId, reason:'initial'|'change'|'correction',
  txFrom?: Date }`.
  **`txFrom` (knownAt) is load-bearing and is an addition to the declaration in ARCHITECTURE L602 (§18).**
  Without it transaction time cannot be set at all: `tx_from` would only ever take its column default
  `now()`, and `bt_close_tx`'s `p_now` would too — and `now()` is *transaction start*, so an INSERT
  followed by its close inside one transaction produces `tx_to = tx_from` and raises
  `tx_to must be after tx_from` (bt_guard_update) as well as violating `<table>_tx_range`. Reproduced on
  the local PG 14. Three consequences follow, all of them acceptance criteria elsewhere in this plan:
  TESTING §7.10 `bt.correction` and WP-01's `test/integration/bitemporal.test.ts` (initial 2026-03-01 coupon 4.500,
  correction 2026-03-10 → 4.250, read at `known_at` 2026-03-05 vs 2026-03-12) need two versions written
  in one transaction, because the harness runs one transaction per test (§0.2); this package's own
  `refdata/bitemporal-write.test.ts` needs the same; and TESTING §7.9 `adjust.asof` needs
  `corporate_actions.tx_from = 2020-08-31` for the AAPL split, which a seed can only produce by passing
  the historical instant. So: `writeVersion` writes `tx_from = w.txFrom ?? clock_timestamp()` and passes
  the same instant to `bt_close_tx(…, p_now)`; `bt_close_tx`'s default becomes `clock_timestamp()`
  (DATA_MODEL §1.1.c); `bt_guard_update`'s `NEW.tx_to <= OLD.tx_from` check stays, and callers must pass
  a strictly later instant than the version they are closing. WP-15's seed modules pass the historical
  knowledge instant — SEC `acceptanceDateTime` (`filings.accepted_at`), the Yahoo event date for a
  corporate action — not the seed run's wall clock.
  Every bitemporal table in CONTRACTS §1.2 (`issuers … corporate_actions`, 16 of them) is written
  through these two functions and nothing else; `upsertVersion` returns `null` when the incoming
  data is identical, which is what makes `db:seed` and every ingest job idempotent.
- `refdata/master.ts` — repositories for `issuers`, `issues`, `instruments`, `listings`, `md_lines`;
  `refdata/identifiers.ts` — the `identifiers` cross-reference, keyed
  `(scheme, value, qualifier)` per the exclusion constraint (`TICKER_EXCH` qualifier = exch code,
  `PROVIDER_SYMBOL`/`SERIES_CODE` qualifier = `source_id`).
- `refdata/resolve.ts` — `SecurityResolver`: `SecurityRef | identifier → ResolvedRef` as-of
  `(validAt, knownAt)`, using `identifiers` first, then `instruments.ticker` + `exch_code`, then the
  `normName` fallback; ambiguity returns candidates, never a guess (REF-01, REF-02).
- `refdata/terms.ts` (`govt_terms`, `option_terms`, `future_terms`, `fund_terms`, `index_terms`,
  `fx_terms`, `rate_terms`), `refdata/calendars.ts` (DB rows → core `Calendar` objects),
  `refdata/classifications.ts` (`classification_schemes`/`codes`, `entity_classifications`; **including the
  `wiki-sp500.html` GICS parse** — the only source of GICS sector and sub-industry names for S&P 500
  issuers, source `wiki.sp500`, `licence_kind cc_by_sa`, with its own fixture golden in
  `test/replay/refdata/wikiSp500.test.ts`; MEMB's sector subtotals and SECF's `gicsSector` both read what
  it writes),
  `refdata/indexMembership.ts` (`indices`, `index_members` with weights and history, adds/drops
  between two dates — REF-07), `refdata/corporateActions.ts` (CA repository as-of + the glue that
  hands `corporate_actions` rows to WP-02's `adjustmentFactors` — REF-09),
  `refdata/universe.ts` (seeded universe ∪ Cboe symbol book ∪ SEC tickers merge),
  `refdata/newsDict.ts` (per-run matcher dictionary for WP-09's entity linker, §18.7).
- `data/*` services, each returning values already stamped with `provenance_id` so
  `PayloadMeta.provenance[]` can be built by the runner: `reference` (instrument, terms,
  identifiers, classifications, membership), `historical` (`bars_daily` + adjustment policy),
  `intraday` (`bars_intraday`), `ticks` (`quote_ticks`), `snapshot` (`quote_snapshots`,
  `eod_snapshots`), `fundamentals` (point-in-time read on `filed_at`, DATA_MODEL §8.1 L1336-1361),
  `econ`, `curves`, `rates`, `options`, `news`, `filings`, `holdings`, `portfolio`, and
  `request.ts` — the `DataRequest` dispatcher of API-02 (API.md §4 L289-391).
- Five ingest jobs (PROVIDERS.b §13 L1632-1661 gives `id`, `provider`, `schedule`, target set,
  `priority`, `timeoutMs` for each): `symbologyRefresh` (OpenFIGI + SEC tickers → master rows via
  `upsertVersion`), `universeSymbolBook` (35,618 Cboe entries: **refreshes** existing master rows
  through `upsertVersion` — name changes, new listings, `status` transitions to `'delisted'` for symbols
  that left the book — and contributes search candidates. It does **not** create the universe from
  nothing: the ≈36 k master rows are written once by WP-15's `seed/universe.ts` per DATA_MODEL §3.1
  (`instruments` + `md_lines(cboe.quotes, name)` + `identifiers PROVIDER_SYMBOL`, with the §3.1
  `search_weight` and `status` rules), which is also where WP-15's stated volumes come from (≈36 k
  instruments, ≈90 k identifiers) and what WP-08's `/universe/snapshot` and WP-03's 45 k-entry ranking
  bench are sized against. One writer only: if both the seed and this job created rows, the
  `md_lines_symbol_excl` and `identifiers_bt_excl` constraints would collide), `secNport` (SPY CIK `0000884394` → `index_members`), `ssgaHoldings` (daily SPY file →
  `index_members` + `etf_holdings`), `shortInterest` (FINRA → `short_interest`).
- **Placeholder identifiers in holdings files (both `secNport` and `ssgaHoldings`).** In the recorded
  `sec-nport-SPY-primary_doc.xml` there are 504 `<invstOrSec>` blocks (503 `assetCat EC` + 1 `DE`, hence
  503 index members) but only 476 distinct CUSIPs: **29 holdings carry `<cusip>000000000</cusip>`**,
  foreign-domiciled names (Allegion plc and similar) identified only by `<isin value="IE00BFRT3W74"/>`.
  A CUSIP-first resolver maps all 29 onto one entity, and writing
  `identifiers(scheme='CUSIP', value='000000000', qualifier='')` a second time violates
  `identifiers_bt_excl` with SQLSTATE 23P01, which aborts the job and the seed. So both jobs treat
  `000000000`, any all-zero and any blank CUSIP as **absent**: resolution order is ISIN → LEI → ticker →
  `normName`; a row that still does not resolve gets an `etf_holdings` row with
  `holding_instrument_id NULL` plus a `data_exceptions` row of kind `unresolved_identifier`; and **no
  `identifiers` row is ever written for a placeholder value**.

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/server/test/integration/refdata/bitemporal-write.test.ts` | `writeVersion` closes the prior version and opens the new one; `upsertVersion` no-ops on identical data; the `*_bt_excl` exclusion constraint rejects an overlapping valid range; `bt_guard_update` blocks an in-place update |
| `packages/server/test/integration/refdata/resolve.test.ts` | `AAPL US Equity`, `/isin/US0378331005`, `/cusip/037833100`, `/figi/BBG000B9XRY4`, `912797VE4 Govt`, `SPX Index`, `EURUSD Curncy` all resolve to the seeded instruments; a corrected ticker resolves differently at two `knownAt` values (REF-03) |
| `packages/server/test/integration/refdata/identifiers.test.ts` | `(scheme, value, qualifier)` uniqueness across time; `TICKER_EXCH` qualifier semantics |
| `packages/server/test/integration/refdata/indexMembership.test.ts` | 503 SPX members as-of the N-PORT `repPdDate` and as-of the SSGA file date; adds/drops between the two; weights sum to ≈1 (REF-07) |
| `packages/server/test/integration/refdata/corporateActions.test.ts` | as-of read of `corporate_actions` feeds WP-02 factors; `review_state` dual key (REF-10) |
| `packages/server/test/integration/data/historical.test.ts` | `unadjusted`/`price`/`total_return` series for AAPL across the 2020-08-31 4:1 split; every row carries a `provenance_id` |
| `packages/server/test/integration/data/fundamentals.test.ts` | point-in-time: the same `period_end` returns the originally filed value at `knownAt` = filing date and the restated value later (STOR-06) |
| `packages/server/test/integration/data/request.test.ts` | the `DataRequest` examples in API.md §4 and §12.1 dispatch to the right service and return the documented envelope |
| `packages/server/test/replay/refdata/symbologyRefresh.test.ts` | QA-02: the job run against `openfigi-map` + `sec-company-tickers.json` fixtures produces the expected master rows twice with no second-run writes |
| `packages/server/test/replay/refdata/secNport.test.ts` | `sec-nport-SPY-primary_doc.xml` → 504 `<invstOrSec>` blocks, 503 `assetCat EC` index members, 476 distinct CUSIPs; the 29 `000000000` placeholders resolve by ISIN and write no `identifiers` row; any still-unresolved row becomes `etf_holdings.holding_instrument_id NULL` + a `data_exceptions` row of kind `unresolved_identifier`; a second run writes nothing |

**Size:** XL — 10-13 agent-days.

---

### WP-05 — Provider adapters, parsers, replay store, provenance and the ingest runtime

**Owns**

```
packages/server/src/providers/types.ts http.ts replayStore.ts provenance.ts registry.ts
packages/server/src/providers/{xml,html,csv}.ts
packages/server/src/providers/sim/prng.ts
packages/server/src/providers/openfigi/** cboe/** yahoo/** sec/** fred/** nyfed/** fedH15/**
packages/server/src/providers/treasury/** bls/** worldbank/** imf/** frankfurter/** finra/**
packages/server/src/providers/bbgRss/** fedRss/** coingecko/** ssga/**       (adapter.ts + parse.ts each; ssga also xlsx.ts)
packages/server/src/ingest/scheduler.ts lock.ts hotset.ts
packages/server/src/ingest/jobs/{cboeQuotes,cboeEuIndices,cboeOptions,yahooIntraday,yahooDaily,fxIntraday,fxEod,crypto}.ts
packages/server/src/ingest/jobs/{partitionMaintenance,retentionPurge,dqMonitors,reconcile}.ts
packages/server/src/db/partitions.ts
packages/server/src/observability/dq.ts
fixtures/providers/normalised/**
packages/server/test/replay/providers/**
packages/server/test/unit/providers/**
packages/server/test/integration/ingest/**
```

**Depends on:** WP-01. WP-04 for `writeVersion`/`upsertVersion` and the master repositories
(interface known from day one; the reference-writing jobs land after WP-04's `bitemporal.ts`).

**Imports from WP-01:** `providers/licences.ts` (the 33 `source_id` values — an adapter's
`ProviderId` **is** its `licence_registry.source_id`), `config.ts` (`PROVIDER_MODE`, `REPLAY_DIR`,
`SEC_USER_AGENT`, API-key envs), `db/client.ts`, `NormalisedUpdate`, `QuoteFields`, `Timestamps3`,
`ProvRef`, `Clock`.

**Builds** (PROVIDERS.a §1-5 and PROVIDERS.b §6-12, §14 — read the numbered subsection for each
adapter you are writing; every adapter has its recorded fixture named in FIXTURES.md)

- `providers/types.ts` — `ProviderAdapter`, `RawRecord`, `Normalised<T>`, `ProviderId`
  (PROVIDERS.a §1.1 L8-87). The fetch/normalise split is mandatory: `adapter.ts` builds URLs and
  headers and returns a `RawRecord`; `parse.ts` is pure and is a QA-05 fuzz target.
- `providers/http.ts` — `HttpClient.get({providerId, url, headers?, body?, cacheTtlMs?}) → RawRecord`
  with three modes `live | record | replay`, per-host token buckets (PROVIDERS.a §2.2 L257-276 has
  the real limits: OpenFIGI 25/min keyless, SEC 10/s, Cboe, Yahoo browser-UA requirement),
  retry/backoff with jitter, ETag/TTL cache, circuit breaker → `PROVIDER_DOWN` after 5 consecutive
  failures, half-open after 60 s, and the 70 % scheduler share of every bucket.
- `providers/replayStore.ts` — `requestKey = sha256(providerId|METHOD|url-sorted-query|sha256(body))`
  hex, `fixtures/providers/manifest.json` read/write, and the rule that **replay mode is a wall**:
  a miss throws, it never falls through to the network (PROVIDERS.a §3.2, §3.6).
- `providers/provenance.ts` — `insertProvenance(raw) → provenanceId` writing `request_key`,
  `request_url`, `request_hash`, `response_sha256`, `http_status`, `bytes`, `captured_at`,
  `source_ts`, `adapter_version`, `trace_id`, `run_id` (DATA-10). No value is written to any table
  without one.
- Seventeen adapter directories. Each `parse.ts` emits either `NormalisedUpdate[]`
  (ARCHITECTURE L539-556) for quote-shaped sources or typed rows for table-shaped sources, and a
  golden file under `fixtures/providers/normalised/<raw-file>.json`. The four shared parsers
  `xml.ts`, `html.ts`, `csv.ts`, `ssga/xlsx.ts` are additions carried from PROVIDERS.b §16.5 (§18.5).
- `providers/sim/prng.ts` + the deterministic simulated feed (PROVIDERS.a §4 L514-618): seeded PRNG
  driving `plant.apply` for tests that need a feed without fixtures; runs are bit-identical.
- `ingest/scheduler.ts` — the `IngestJob` contract verbatim (ARCHITECTURE L974-983): 1-second tick
  on the injected `Clock`, one running instance per job, `pg_try_advisory_lock(hashtext('ingest-leader'))`
  in `lock.ts`, `2^n × 5 s` backoff capped at 10 min, one `ingest_runs` row per execution with
  `job_id` = module basename (PROVIDERS.b §13 fixes this convention, §18.4).
- `ingest/hotset.ts` — subjects to poll: subscribers ∪ connected users' watchlists ∪ the always-on
  seed set.
- Twelve market-data and maintenance jobs, each one file, parameters from the PROVIDERS.b §13 table.
  `partitionMaintenance` and `retentionPurge` use `db/partitions.ts`
  (`ensurePartitions(table, horizonMonths)`, `dropExpired(table, retentionDays)`, DATA_MODEL §7.3
  L1197-1225) and read `licence_registry.retention_days` as the **only** retention input (STOR-07) —
  three rows carry a number (`cboe.quotes` 30 → `quote_ticks`, `cboe.options` 10 → `option_quotes`,
  `yahoo.chart` 400 → `bars_intraday`) and `access_log`/`usage_events` add their `retentionFloorDays`
  (2557 / 730); everything else is unlimited. **Both functions run on `db/client.ts#withMaintTx`**, the
  `terminal_maint` connection: creating a partition needs CREATE on the schema and dropping one needs
  ownership, neither of which `terminal_app` has (DATA_MODEL §15.d.1). On PG 14 the legacy `PUBLIC
  CREATE` grant on schema `public` hides half of this in development, so it must be tested against the
  role, not assumed.
- `observability/dq.ts` — the monitors of PROVIDERS.b §14 (L1671-1745) writing `dq_events` with the
  exact `kind` values of the CHECK list: `stale_tick`, `cross_source_divergence`, `missing_close`,
  `field_population`, `poll_anomaly`, `provider_circuit_open`, `reconcile_mismatch`, `parse_error`,
  `default_partition_nonempty`, `ref_orphans`, `ws_backpressure`, `plant_degraded`, `replay_diff`.

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/server/test/replay/providers/<source>.test.ts` (one per `source_id`) | QA-02: `parse.ts` over the recorded fixture equals the committed `fixtures/providers/normalised/<file>.json` golden, byte for byte |
| `packages/server/test/unit/providers/parse.fuzz.test.ts` | QA-05: every `parse.ts` plus `xml/html/csv/xlsx` never throws on truncated, reordered or corrupted input; returns a parse-error result instead |
| `packages/server/test/unit/providers/requestKey.test.ts` | key derivation is stable under query reordering and differs on body change; matches the keys in `manifest.json` |
| `packages/server/test/replay/providers/replay-wall.test.ts` | a request with no fixture throws in `replay` mode and never opens a socket |
| `packages/server/test/unit/providers/http.test.ts` | token bucket, 3-retry backoff, ETag revalidation, circuit opens at 5 failures and half-opens at 60 s on a `VirtualClock` |
| `packages/server/test/integration/ingest/scheduler.test.ts` | leader lock prevents a double run; failure backoff sequence; one `ingest_runs` row per execution with the basename `job_id` |
| `packages/server/test/integration/ingest/partitions.test.ts` | `ensurePartitions` creates next month for all six partitioned tables and `dropExpired` drops an expired one **while connected as `terminal_maint`**, and both fail with `permission denied` / `must be owner of table` as `terminal_app` (so the role split is asserted, not assumed); `dropExpired` reads the retention it enforces **from `licence_registry`**, never from a literal in the test, and honours the `retentionFloorDays` of `access_log`/`usage_events` and any open `legal_holds` row; a non-empty default partition raises `dq_events.kind='default_partition_nonempty'` |
| `packages/server/test/integration/ingest/reconcile.test.ts` | Cboe vs Yahoo close divergence > 0.5 % writes `cross_source_divergence` (QA-03) |
| `packages/server/test/unit/providers/sim/prng.test.ts` | two runs from the same seed produce identical update streams |

**Size:** XL — 12-15 agent-days (seventeen adapters; shardable by adapter directory since each is
its own folder with its own golden).

---

### WP-06 — Quote model, ticker plant and the WebSocket gateway

**Owns**

```
packages/core/src/quote/**                merge.ts staleness.ts session.ts derive.ts
packages/core/src/fields/defs/price.ts
packages/server/src/plant/**              tickerPlant.ts subjects.ts composite.ts policyTier.ts eod.ts
                                          staleness.ts warm.ts store.ts
packages/server/src/ws/**                 gateway.ts session.ts conflator.ts protocol.ts
packages/core/test/quote/**
packages/server/test/unit/plant/**
packages/server/test/integration/ws/**
```

`plant/tickerPlant.ts` and `ws/gateway.ts` are created as stubs by WP-01 and owned here from then on.

**Depends on:** WP-01 (`wire/ws.ts` schemas, `QuoteState`, `NormalisedUpdate`). Interface-level on
WP-05 (`plant.apply` is called by ingest jobs) and WP-07 (`policyTier` consumes the entitlement
decision). **Blocks nothing**, but WP-13 cannot finish its resync tests without it.

**Imports from WP-01:** `QuoteState`, `LineState`, `QuoteFields`, `QuoteFieldId`, `Timestamps3`,
`ProvRef`, `SessionState`, `ValueState`, `Tier`, `NormalisedUpdate`, `Clock`,
`sdk/wire/ws.ts` (`ClientMsg`, `ServerMsg`, `Snap`, `Delta`, `Status`, `SubjectId`), `ReasonCode`.

**Builds** (ARCHITECTURE §6 L755-968 — read it whole, it is the package's spec; API.md §6 L839-1053
for the wire-level rules)

- `core/quote/merge.ts` — the composite merge across md lines (BUS-05): line priority from
  `md_lines.priority` (cboe 10, yahoo 20), field-level last-writer-wins by `ts.src` with
  `srcSeq` as the tiebreak, and per-field provenance retained in `QuoteState.lines[]`.
- `core/quote/staleness.ts` — `valueState(q, now)`, **the single staleness implementation**
  (TERM-12): the limit is `3 × expectedIntervalMs` (ARCHITECTURE L557-566). Both the server sweep
  and the SDK's 1 s ticker call this function; nothing re-implements it.
- `core/quote/session.ts` — `sessionState(calendar, now, hasPrePost) → SessionState` over the
  `session_state` enum `pre|open|auction|halted|closed|post|unknown` (FEED-06).
- `core/quote/derive.ts` — `CHG_NET_1D`, `CHG_PCT_1D`, `TICK_DIR` from fields (`tick_dir` is the
  `u|d|f` CHECK on `quote_ticks`).
- `plant/subjects.ts` — the subject grammar of ARCHITECTURE §6.1 (L757-774), parse/format for
  `q:<instrumentId>`, `l:<mdLineId>`, `b1m:<instrumentId>`, `oc:<instrumentId>`, `c:<curveId>`,
  `r:<rateCode>`, `e:<seriesCode>`, `n:<scope>`, `alerts:me`, `room:<roomId>`, `sys:status`,
  matching the `SubjectId` regex in `sdk/wire/ws.ts` exactly.
- `plant/tickerPlant.ts` — `Map<subject, QuoteState>`, `apply(update)` (drops `src_seq ≤ last`),
  `snapshot(subject)`, `subscribe()`; per-subject monotonic `seq`.
- `plant/store.ts` — **the writer for tick and snapshot rows**, and the only one: `writeTick(row)` →
  `quote_ticks`, `upsertSnapshot(subject, seq, state)` → `quote_snapshots` (`subject`, `seq`, `state`
  jsonb), `writeEodSnapshot(...)` → `eod_snapshots`, all through `db/client.ts#withTx`, batched per
  flush. It is listed here because WP-04 owns `data/**` as the **reader** surface only (`ticks.ts`,
  `snapshot.ts` are readers) and `refdata/**` covers reference tables, so nothing in WP-04 writes these
  three tables; without `plant/store.ts` either WP-06 reaches around its own layering or the rows are
  never written and `plant/warm.ts`, `plant/eod.ts` and the Q/QM tape have no source. It writes only
  these three tables and reads none.
- `plant/composite.ts` (applies `core/quote/merge.ts` and sets `dq` flags), `plant/policyTier.ts`
  (`view(state, tier)`: `realtime` → identity, `delayed` → identity (all v1 sources are already
  delayed) / ring-fenced fields, `eod` → frozen at `eod_snapshots`; BUS-06),
  `plant/eod.ts` (official-close snapshot builder → `eod_snapshots.fields` with
  `PX_OFFICIAL_CLOSE`, `PX_CLOSE_1D`, `PX_OPEN/HIGH/LOW`, `PX_VOLUME`),
  `plant/staleness.ts` (1 s sweep emitting `status` frames only on transition),
  `plant/warm.ts` (warm start from `quote_snapshots`).
- `ws/gateway.ts` — upgrade on `/ws/v1`, cookie or bearer auth, session binding, dispatch;
  `ws/session.ts` — per-socket subscriptions, `Uint32Array` field masks, backpressure state machine;
  `ws/conflator.ts` — the `Conflator` of ARCHITECTURE L820-858: dirty-mask conflation at
  `CONFLATION_MS_DEFAULT` with the **latest-value guarantee** (values read at flush time, never
  queued), slow-consumer downgrade (BUS-04), `essential` flag handling — plus the two carve-outs
  API.md §6.4 states that a dirty mask cannot express: **`n:*` (news) subjects are queued, not
  conflated** — one `delta` per headline, in `publishedAt` order, never overwritten, because a
  latest-value mask would silently drop every headline but the last in a window (NEWS-01) — and
  **`eod`-tier subjects flush at most every 60 000 ms**, a floor independent of `effectiveMs`. A flush
  that would exceed the 1 MiB frame cap, and the initial snapshot burst, are split across consecutive
  `batch` frames within the one flush (API.md §6.4 snapshot-burst exception);
  `ws/protocol.ts` — encode/decode strictly through the SDK zod schemas.
- Handshake and sequencing (API.md §6.3 L916-946): `hello` → `welcome`, `sub` → `snap` then
  `delta` with `prev` chaining; a gap forces a resync; resubscribe-on-reconnect replays snapshots.
- Entitlement on subscribe (API.md §6.6 L981-993): every subject and field is checked through
  WP-07's evaluator; denials come back as `notice` with a `ReasonCode` and the subject renders
  downgraded rather than disappearing (ENTL-05).

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/core/test/quote/staleness.test.ts` | `valueState` transitions live → stale at `3 × expectedIntervalMs`, closed outside the session, `blank`/`na` cases (TERM-12) |
| `packages/core/test/quote/merge.test.ts` | composite merge across a cboe line and a yahoo line: priority, per-field `ts.src` wins, provenance retained (BUS-05) |
| `packages/core/test/quote/session.test.ts` | pre/open/auction/closed/post across an NYSE early-close day |
| `packages/server/test/unit/plant/subjects.test.ts` | every subject form parses and re-formats; invalid subjects rejected by the same regex as the wire schema |
| `packages/server/test/unit/plant/tickerPlant.test.ts` | `seq` strictly increases per subject; a replayed `src_seq` is dropped; snapshot equals the applied state |
| `packages/server/test/unit/plant/conflator.test.ts` | BUS-03: N updates inside one conflation window emit one frame carrying the **latest** value of every changed field; nothing is lost. Plus the carve-outs: two headlines on one `n:` subject inside one window produce **two** deltas in `publishedAt` order (NEWS-01), never one; an `eod`-tier subject does not flush twice inside 60 s; and a flush larger than the 1 MiB frame cap is emitted as consecutive `batch` frames whose per-subject `prev` chain is still contiguous |
| `packages/server/test/integration/ws/handshake.test.ts` | `hello`/`welcome`, `sub` → `snap` then `delta` with `prev` chaining, exactly the exchange in API.md §6.8 (L1013-1039), driven by **one recorded snapshot plus simulated follow-on ticks**: `cboe-quote-AAPL.json` is a single 531-byte poll (one `seqno`, one `last_trade_time`) and there is no second observation for any quote source anywhere in `fixtures/providers/raw/`, so no delta can be derived from it. The `snap` comes from the fixture; every subsequent tick comes from WP-05's deterministic `providers/sim/prng.ts` feed (PROVIDERS.a §4) seeded from that snapshot, which is bit-identical across runs |
| `packages/server/test/integration/ws/resync.test.ts` | BUS-07: a forced gap produces a resync and a fresh `snap`; the client's `lastSeq` chain is intact afterwards |
| `packages/server/test/integration/ws/backpressure.test.ts` | BUS-04: a slow consumer is downgraded, emits `usage_events.kind='ws.slow'` and a `dq_events.kind='ws_backpressure'` row, and is never silently dropped |
| `packages/server/test/integration/ws/entitlement.test.ts` | ENTL-05: an `eod` user subscribing to `q:` gets frozen values and a `notice` with the reason code |

**Size:** L — 8-10 agent-days.

---

### WP-07 — Entitlements, auth, access log, quotas and compliance

**Owns**

```
packages/server/src/entitlements/**       evaluator.ts licenceRegistry.ts accessLog.ts quotas.ts declarations.ts
packages/server/src/http/auth/**          session.ts webauthn.ts password.ts apikeys.ts
packages/server/src/http/routes/auth.ts
packages/server/src/http/routes/usage.ts
packages/server/src/http/routes/admin.ts
packages/server/test/integration/entitlements/**
packages/server/test/integration/auth/**
packages/server/test/unit/entitlements/**
```

**Depends on:** WP-01 (`licences.ts`, the `users`/`firms`/`entitlement_grants`/`access_log` schema).
WP-06 consumes the evaluator; WP-08 calls it from the runner. No blocking dependency either way —
the `EntitlementDecision` type ships in WP-01.

**Imports from WP-01:** `EntitlementRequest`, `FieldDecision`, `EntitlementDecision`, `ReasonCode`,
`UsageType`, `Tier`, `FieldClass`, the field dictionary (`fieldClass` and `sources[]` per field),
`providers/licences.ts`, `db/client.ts`.

**Builds** (ARCHITECTURE §10 L1138-1172 is the evaluator spec; API.md §1 L48-131 auth, §8 L1129-1160
quotas, §5.13 L765-785 and §5.14 L786-838 routes)

- `entitlements/evaluator.ts` — `evaluate(req: EntitlementRequest) → EntitlementDecision`,
  per user × instrument × field class × latency tier × usage type. Rule order matters and is
  normative: (1) user grant, (2) firm grant, (3) **source ceiling** `licence_registry.max_tier`
  (no grant can exceed it), (4) usage flags `display`/`non_display`/`export_allowed`/`api_allowed`
  vs the requested `usage_type`, (5) quota. Result per field is `allow | downgrade | deny` with a
  `ReasonCode` from the fixed set `OK | SOURCE_TIER_CAP | NOT_ENTITLED_TIER | NO_FIRM_ENTITLEMENT |
  NO_USER_ENTITLEMENT | …`. Default tier is `delayed` (BRIEF §5.6).
- `entitlements/licenceRegistry.ts` — in-memory copy of `licence_registry` + `field_licence`,
  invalidated by `config_versions` bumps (the `licence_registry_bump` / `field_licence_bump` /
  `entitlement_grants_bump` triggers already exist).
- `entitlements/accessLog.ts` — ring buffer → bulk insert into `access_log` every 1 s or 5,000 rows
  (ENTL-04), never on the request path; every row carries `user_id`, `firm_id`, `session_id`,
  `instrument_id`, `field_id`, `field_class`, `source_id`, `requested_tier`, `tier`, `usage`,
  `purpose`, `decision`, `reason`, `trace_id`.
- `entitlements/quotas.ts` — daily unique instruments (`quota_instruments_seen`), monthly data
  points (`quota_counters`), concurrent subscriptions, against `quota_limits` (API-06);
  `GET /usage/quota` (API.md L1143) returns the live counters.
- `entitlements/declarations.ts` — the monthly per-source declaration **as a query over
  `access_log`** into `usage_declarations`, storing `query_sql_hash` = sha256 of the SQL text that
  produced the row (ENTL-06, DATA-02). Owns `ingest/jobs/usageDeclarations.ts`.
- `http/auth/session.ts` — cookie sessions, token stored only as `digest(token,'sha256')` in
  `sessions.token_hash`, single active session per user with `revoke_reason='superseded'`;
  `webauthn.ts` — FIDO2 registration/assertion against `user_credentials` (`credential_id`,
  `public_key`, `sign_count`, `aaguid`, `transports`) for SEC-02; `password.ts` — dev-only login
  against `secret_hash` (`crypt(password, gen_salt('bf',12))` via pgcrypto); `apikeys.ts` — bearer
  keys bound to a user with `scopes` (API-01).
- Routes: `POST /auth/login` and `POST /api/v1/auth/login`, the `usage.ts` route group
  (`/usage/quota`, `/usage/functions`), and `admin.ts` (`POST /admin/users`, trace lookup
  delegation, declarations, `data_exceptions` review for REF-10, legal holds, REG-04 erasure —
  API.md §5.14).
- RLS verification: tenant isolation is enforced by migration 0015; this package owns the tests
  that prove it (PORT-07, SEC-05, SEC-06).

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/server/test/unit/entitlements/evaluator.test.ts` | the five rules in order; `SOURCE_TIER_CAP` beats a generous grant; per-field `downgrade` list is complete |
| `packages/server/test/integration/entitlements/accessLog.test.ts` | one row per field read with the right `decision`/`reason`; batching flushes at 1 s and at 5,000 rows; the WORM trigger rejects `UPDATE`/`DELETE` (REG-01) |
| `packages/server/test/integration/entitlements/quotas.test.ts` | daily unique instrument cap, monthly data-point cap, concurrent-subscription cap; 429 envelope shape from API.md §8 |
| `packages/server/test/integration/entitlements/declarations.test.ts` | ENTL-06: the generated `usage_declarations` row reconciles with `firms.seat_count` and records `query_sql_hash` |
| `packages/server/test/integration/entitlements/rls.test.ts` | PORT-07: a user of `Other Desk` cannot read `Demo Capital` portfolios, positions, watchlists or rooms, even with a direct query under the app role |
| `packages/server/test/integration/auth/session.test.ts` | login → cookie, token never stored in clear, second login supersedes the first, expiry and revoke reasons |
| `packages/server/test/integration/auth/webauthn.test.ts` | SEC-02: registration and assertion, `sign_count` rollback rejected |
| `packages/server/test/integration/auth/apikeys.test.ts` | API-01: bearer key scopes gate `fn:run` and `ws:subscribe`; a revoked key 401s |

**Size:** L — 8-10 agent-days.

---

### WP-08 — Function runner, HTTP routes, export and observability

**Owns**

```
packages/server/src/functions/runner.ts context.ts resultCache.ts export.ts
packages/server/src/http/trace.ts errors.ts
packages/server/src/http/routes/{data,functions,export,fields,reference,search,universe,status,health,workspaces}.ts
packages/server/src/search/snapshot.ts rank.ts
packages/server/src/observability/{logger,metrics,usageEvents,traceQuery}.ts
packages/server/test/unit/functions/**
packages/server/test/integration/functions/**   (except the per-code files owned by WP-09/10/11)
packages/server/test/integration/search/**
packages/server/test/integration/observability/**
```

**Depends on:** WP-01 (manifest/registry/csv, wire schemas), WP-04 (`DataServices`), WP-07
(evaluator, access log). The tier packages (WP-09/10/11) **depend on this package's
`ResolveContext`**, which is why `context.ts` is the first file to land.

**Imports from WP-01:** `FunctionManifest`, `FunctionRegistry`, `toCsv`, `writeCsv`, `Payload<T>`,
`PayloadMeta`, `UnavailableReason`, `wire/rest/*`, `wire/dataRequest.ts`, `ErrorEnvelope`.

**Builds** (FUNCTIONS.md §1.4 L212-368 is the runner spec; API.md §5 L392-838 the route table)

- `functions/context.ts` — construction of `ResolveContext` (FUNCTIONS.md L220-350): the injected
  `Clock`, `asOf {validAt, knownAt}`, the resolved security, `DataServices`, `PlantReader`,
  `ReadThrough`, and the three collectors `ProvenanceCollector`, `UnavailableCollector`,
  `EngineCollector`. **This is the only way a resolver touches data** — resolvers never import
  `db/client.ts`, and an ESLint zone enforces it.
- `functions/runner.ts` — the eleven steps of FUNCTIONS.md §1.4.3: parse params with the manifest's
  zod schema → resolve the security → choose the variant by `asset_class` (FUNC-02) → entitle →
  resolve → stamp `meta` (provenance, unavailable, engines, asOf, tier, attribution) → cache the
  result → emit `usage_events.kind='fn.launch'`. Every error path maps to a documented
  `ErrorEnvelope` code.
- `functions/resultCache.ts` — `resultId → CachedResult`, LRU 500 per user, 10 minutes, and
  `get()` returns `undefined` for another user (FUNCTIONS.md L351-352).
- `functions/export.ts` — CSV export by `resultId` **or** by re-resolving at the stored `asOf`;
  re-checks entitlement with `usage='export'` and refuses per-field when `export_allowed` is false
  (FUNC-03, ENTL-01); output goes through `core/functions/csv.ts` so screen and file cannot
  disagree; attribution lines from `licence_registry.attribution` (API.md §9 L1161-1201).
- Routes: `POST /data` and `POST /api/v1/data` (the one request model, API-02);
  `POST /api/v1/functions/:code/run` and `GET /api/v1/functions/:code/csv`;
  `GET /api/v1/data/snapshot`; `GET /fields` and `GET /fields/changelog` (API-07);
  `reference.ts` (REF-01..09 reads); `search.ts` + `universe.ts` (`/universe/snapshot` with ETag,
  `GET /api/v1/search` name fallback ≥ 3 chars); `status.ts` + `health.ts` (OPS-03, OPS-04);
  `workspaces.ts` (TERM-04/05/10, CHRT-05 — `workspaces.version` optimistic concurrency, PUT with a
  stale `version` → 409).
- `search/snapshot.ts` — the universe snapshot (instruments + functions + people + topics) with an
  ETag, sized for the ≈36 k seeded instruments; `search/rank.ts` — server-side fallback delegating
  to `core/command/rank.ts`.
- `observability/*` — `logger.ts` (pino with the trace id as a child binding), `metrics.ts`
  (in-process counters/histograms, Prometheus text at `/metrics`), `usageEvents.ts` (batched
  `usage_events` writer over the exact `kind` CHECK list: `fn.launch`, `fn.param`, `fn.page`,
  `fn.export`, `fn.help`, `search.select`, `cmd.parse_error`, `panel.switch`, `ws.subscribe`,
  `ws.slow`, `ws.resync`, `ticket.open` — FUNC-04), `traceQuery.ts`
  (`GET /api/v1/admin/trace/:traceId` joining `access_log`, `usage_events`, `provenance`, `ingest_runs`
  on `trace_id` — OPS-07).

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/server/test/unit/functions/runner.test.ts` | steps 1-11 of FUNCTIONS.md §1.4.3 including every error code, alias params and the variant assertion (FUNCTIONS §8 row) |
| `packages/server/test/integration/functions/export.test.ts` | resultId path, regenerated-at-asOf path, denied field → 403, CSV headers and attribution, one `usage_events` row (FUNCTIONS §8 row) |
| `packages/server/test/integration/functions/resultCache.test.ts` | expiry at 10 min on a `VirtualClock`; another user's `resultId` returns `undefined`, not data |
| `packages/server/test/integration/functions/data-request.test.ts` | API-02: the §12.1 worked example (API.md L1377-1414) returns the documented envelope with `asOf` and adjustment applied |
| `packages/server/test/integration/search/snapshot.test.ts` | ETag 304 on repeat; snapshot contains instruments + functions + people + topics; size budget |
| `packages/server/test/integration/search/fallback.test.ts` | `GET /api/v1/search` ranks the same way `core/command/rank.ts` does for a ≥3-char name query |
| `packages/server/test/integration/observability/trace.test.ts` | OPS-07: one `x-trace-id` threads through `access_log`, `usage_events` and `provenance`, and `/admin/trace/:traceId` returns all three |
| `packages/server/test/integration/observability/usage.test.ts` | one row per launch/param/page/export, `params_hash` stability, the client batch route (FUNCTIONS §8 row) |
| `packages/server/test/integration/functions/errors.test.ts` | every `ErrorEnvelope` shape in API.md §2 (L132-197), including the per-field denial of §12.3 |

**Size:** L — 8-11 agent-days.

---

### WP-09 — Tier 1 functions, news pipeline, entity resolution and messaging

Fourteen codes (BRIEF §6 / FUNCTIONS.md §6 L1070-1083): `DES`, `GP`, `GIP`, `HP`, `Q`, `QM`, `W`,
`TOP`, `N`, `NI`, `MSG` (`IB`), `WEI`, `HELP`, `SECF` — plus the news and messaging services the
news and chat functions read from.

**Owns**

```
packages/core/src/functions/manifests/{DES,GP,GIP,HP,Q,QM,W,TOP,N,NI,MSG,WEI,HELP,SECF}.ts
packages/server/src/functions/{DES,GP,GIP,HP,Q,QM,W,TOP,N,NI,MSG,WEI,HELP,SECF}/resolve.ts
packages/web/src/screens/{DES,GP,GIP,HP,Q,QM,W,TOP,N,NI,MSG,WEI,HELP,SECF}/Screen.tsx
packages/server/src/news/**               ingest.ts entityLink.ts ranker.ts
packages/server/src/messaging/**          service.ts surveillance.ts
packages/server/src/alerts/engine.ts
packages/server/src/ingest/jobs/newsRss.ts
packages/server/src/http/routes/{news,messages,alerts,watchlists,help}.ts
packages/core/src/fields/defs/news.ts
packages/server/test/integration/functions/{DES,GP,GIP,HP,Q,QM,W,TOP,N,NI,MSG,WEI,HELP,SECF}.test.ts
packages/server/test/integration/news/**
packages/server/test/integration/messaging/**
packages/web/test/screens/tier1/**
```

**Depends on:** WP-08 (`ResolveContext`, runner, routes), WP-04 (`DataServices`), WP-06 (`LiveSpec`
subjects for live screens), WP-12 (`ScreenRenderer` and the widget set — screens compile against
`ScreenSpec` from WP-01 and render once WP-12 lands).

**Shardable as two independent file sets:** **09A** the fourteen manifests + resolvers + screens;
**09B** `news/**`, `messaging/**`, `alerts/engine.ts`, `newsRss.ts` and the four routes. The sets
are disjoint; 09A's `TOP`/`N`/`NI`/`MSG` resolvers consume 09B through `DataServices.news` and the
messaging service interface.

**Builds**

- One manifest per code following the §1.2 rules and the FUNCTIONS_TIER1.md entry for that code
  (`docs/FUNCTIONS_TIER1.md`, grep for `^## <CODE>` and read that entry only): `code`, `aliases`,
  `name`, `tier: 1`, `category`, `assetClasses` → variants **exactly** as the §6 table's
  "Asset classes (→ variants)" column (the tier files may not narrow or widen them), zod `params`,
  `ParamGrammar`, `LiveSpec`, `CsvSpec`, `HelpSpec`, `KeyBinding[]`.
- One server resolver per code with `variants` keyed by `AssetClass` for the polymorphic ones —
  `DES` has eight variants (`equity`, `index`, `fx`, `govt`, `option`, `crypto`, `rate`, `econ`),
  `GP` seven, `HP` two (`price`, `series`) (FUNC-02).
- One `Screen.tsx` per code returning a `ScreenSpec` built from the fixed `Node` set
  (`Split | KeyValue | Grid | Table | Chart | Tabs | Form | Text | List | Badges | Custom`); every
  `Cell` that shows a number carries its `fieldId` and a provenance index so `Ctrl+I` works.
- `news/ingest.ts` — RSS/Atom → `news_items` keyed `(source_id, provider_guid)`, HTML stripped from
  `summary`, `is_correction` detection ("Correct:", "Fixes headline"), `machine_generated` always
  false in v1 (NEWS-08 — the column exists so the render rule is enforceable).
- `news/entityLink.ts` — precision-first resolution writing `news_entity_links` with the exact
  `method` CHECK values and their confidences: `cik` 1.0, `ticker_exact` 1.0, `name_exact` 0.95,
  `name_alias` 0.9, `feed_topic`, `keyword`, `manual`. **Links below 0.9 are never written**
  (NEWS-02, PROVIDERS.b §11.3 L1457-1550). Uses WP-04's `refdata/newsDict.ts` matcher dictionary,
  built once per run, and WP-03's `normName`.
- `news/ranker.ts` — TOP ranking (recency × source weight × entity salience), live prepend over
  `n:` subjects.
- `messaging/service.ts` — rooms, append-only `messages` with the `messages_chain` hash chain
  (`prev_hash`, `hash`, per-room `seq`), idempotent send via `client_msg_id`, MSG-04 attachments
  (`security|chart|function|portfolio|watchlist` refs rendered live inside the recipient's
  entitlements), MSG-03 policy: `rooms.wall_tag` ethical walls, `retention_days` floor of 7 years,
  disclaimer on join, permitted counterparty firms; `messaging/surveillance.ts` — lexicon regex →
  `surveillance_hits` with review states.
- `alerts/engine.ts` — evaluation on plant deltas (`price`: `>=`/`<=`/`crosses`), news
  (saved search), filing (`ciks/forms/items`) and calendar (`releaseId`, `minutesBefore`) →
  `alert_events` → `alerts:me` WebSocket subject (NEWS-07).
- Routes `news.ts` (NEWS-01/02/07/08 including saved searches), `messages.ts` (MSG-01..06),
  `alerts.ts`, `watchlists.ts` (W, CHRT-07 formula columns), `help.ts` (TERM-09 ticket creation and
  the helpdesk room).

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/server/test/integration/functions/DES.test.ts` | all eight variants resolve for seeded securities; every displayed value carries a provenance index; unavailable fields carry a reason |
| `packages/server/test/integration/functions/HP.test.ts` | periodicity, adjustment basis (REF-09), paging, CSV parity; the §12.1 example reproduces exactly |
| `packages/server/test/integration/functions/Q.test.ts` | composite + per-line view with all three timestamps (FEED-05) and the `BUS-05` merge visible |
| `packages/server/test/integration/functions/QM.test.ts` | live grid payload over a watchlist and over SPX members; `LiveSpec.subjects` are valid `q:` subjects |
| `packages/server/test/integration/functions/WEI.test.ts` | 31 seeded indices with returns and session state, including the Cboe European ones |
| `packages/server/test/integration/functions/SECF.test.ts` | filters, facets, paging, Yahoo fallback marking (FUNCTIONS §8 row) |
| `packages/server/test/integration/functions/HELP.test.ts` | help per variant, search ranking, ticket creation and room (FUNCTIONS §8 row) |
| `packages/server/test/integration/news/entityLink.test.ts` | NEWS-02 precision: over the 160 seeded stories, every written link is ≥ 0.9; a known ambiguous headline produces **no** link; CIK links from `sec-8k-atom.xml` are 1.0 |
| `packages/server/test/integration/news/ingest.test.ts` | dedupe on `(source_id, provider_guid)`, correction detection, `tsv` search returns the expected story |
| `packages/server/test/integration/messaging/chain.test.ts` | MSG-02: `hash` chain verifies over a room; an attempted `UPDATE` is blocked by the WORM trigger; a broken chain is detectable |
| `packages/server/test/integration/messaging/policy.test.ts` | MSG-03: ethical wall blocks a cross-desk room join; external-firm policy enforced; retention floor cannot be lowered |
| `packages/server/test/integration/alerts/engine.test.ts` | a price alert fires once when `one_shot`, writes `alert_events` and reaches `alerts:me` |
| `packages/web/test/screens/tier1/screens.test.tsx` | every Tier 1 `Screen.tsx` renders its payload fixture; every `Node` kind is keyboard-operable |

**Size:** XXL — 14-18 agent-days; run as 09A + 09B in parallel (≈9 and ≈8 days).

---

### WP-10 — Tier 2 functions, fundamentals ingest and portfolios

Fourteen codes (FUNCTIONS.md §6 L1084-1097): `FA`, `EE`, `EQS`, `RV`, `CN`, `CACS`, `CF`, `ECO`,
`PORT`, `HDS`, `MEMB`, `BTMM`, `FXC`, `WB`.

**Owns**

```
packages/core/src/functions/manifests/{FA,EE,EQS,RV,CN,CACS,CF,ECO,PORT,HDS,MEMB,BTMM,FXC,WB}.ts
packages/server/src/functions/{FA,EE,EQS,RV,CN,CACS,CF,ECO,PORT,HDS,MEMB,BTMM,FXC,WB}/resolve.ts
packages/web/src/screens/{FA,EE,EQS,RV,CN,CACS,CF,ECO,PORT,HDS,MEMB,BTMM,FXC,WB}/Screen.tsx
packages/server/src/portfolio/service.ts
packages/server/src/http/routes/portfolios.ts
packages/server/src/ingest/jobs/{secSubmissions,secCompanyFacts,secFrames}.ts
packages/core/src/fields/defs/fundamental.ts
packages/core/src/fields/defs/portfolio.ts
packages/server/test/integration/functions/{FA,EE,EQS,RV,CN,CACS,CF,ECO,PORT,HDS,MEMB,BTMM,FXC,WB}.test.ts
packages/server/test/integration/portfolio/**
packages/server/test/replay/fundamentals/**
packages/web/test/screens/tier2/**
```

**Depends on:** WP-08 (`ResolveContext`), WP-04 (`data/fundamentals.ts`, `data/filings.ts`,
`data/holdings.ts`, `refdata/indexMembership.ts`), WP-02 (ratios, exposure, attribution, VaR),
WP-05 (the SEC adapters behind the three ingest jobs), WP-12 (renderer).

**Builds**

- Manifests and resolvers per the FUNCTIONS_TIER2.md entry for each code (grep `^## <CODE>` in
  `docs/FUNCTIONS_TIER2.md` and read that entry only), with the §6 variant map: `FA` equity →
  `equity`, etf → `fund`; `CN`/`CACS` equity,etf → `issuer`, index → `members`; `MEMB` index →
  `index`; the rest `none → default`.
- `FA` reads `fin_statements` point-in-time by `filed_at` with the "as reported" toggle served from
  `fin_statements.as_reported` (`{standard_item: {concept, value, fact_id}}`), `mapping_version`
  shown on screen (STOR-06, DATA-06).
- `EE` is built from SEC actuals plus the next expected report date; the estimate columns are
  emitted through `UnavailableCollector` with reason `NO_SOURCE` and the detail string required by
  BRIEF §2 — never blank, never zero.
- `EQS` screens over `xbrl_frames` (6,264 seeded `Assets CY2024Q4I` rows) plus nightly factors;
  criteria persist in `saved_searches.query` as `ScreenCriteria` with `kind='eqs'`.
- `HDS` serves ETF holders/holdings from `etf_holdings`; 13F is reserved and returns
  `13F_NOT_AVAILABLE` as an `unavailable` entry, not an error.
- `secSubmissions` (filings + 8-K atom → `filings`, `news_items` kind `filing`), `secCompanyFacts`
  (→ `xbrl_facts` keyed on `filed`, then `fin_statements` through `xbrl_concept_map`), `secFrames`
  (→ `xbrl_frames`), all with the schedules and targets of PROVIDERS.b §13.
- `portfolio/service.ts` — CSV upload → `portfolio_imports` with per-row `errors`
  `[{row, identifier, column, reason}]` and `reconciliation`
  `{matched, added, removed, quantityDiffs}`, `positions` with `recon_status`, `lots`, and the
  analytics glue into WP-02's exposure/attribution/risk engines (PORT-01..06), tenant-isolated by
  the `firm_id` RLS column (PORT-07).

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/server/test/integration/functions/FA.test.ts` | AAPL IS/BS/CF for FY and Q from the 40 k seeded facts; `knownAt` before and after a restatement returns different numbers; as-reported toggle cites `fact_id` |
| `packages/server/test/integration/functions/EE.test.ts` | actuals history + next expected date; estimate columns carry `NO_SOURCE` with a reason string |
| `packages/server/test/integration/functions/EQS.test.ts` | a multi-factor screen over `xbrl_frames` returns a stable ranked set; saved screen round-trips |
| `packages/server/test/integration/functions/MEMB.test.ts` | 503 members with weights; **sector subtotals joined from `entity_classifications` (scheme `GICS`, source `wiki.sp500`)** — neither membership source carries a sector: `ssga-spy-holdings.xlsx` has a `Sector` column whose cell is the literal `-` for the sampled rows, and `sec-nport-SPY-primary_doc.xml` carries `assetCat`/`issuerCat`, not GICS. The screen therefore renders the cc_by_sa attribution from `licence_registry.attribution` for `wiki.sp500` alongside the membership source's own (DATA-09); a member with no GICS row is grouped under `—` with an `unavailable` entry, never guessed. Adds/drops between the N-PORT and SSGA dates (REF-07) |
| `packages/server/test/integration/functions/CACS.test.ts` | dividend/split timeline with `estimated → announced → confirmed → paid` states (DATA-08) |
| `packages/server/test/integration/functions/ECO.test.ts` | releases by week with actual/prior/revised; `consensus` null with `consensus_unavailable_reason` populated |
| `packages/server/test/integration/functions/BTMM.test.ts` | policy range, SOFR/EFFR with percentiles, bills, CMT and spreads on one payload from the seeded fixings |
| `packages/server/test/integration/functions/FXC.test.ts` | G10 matrix: direct pairs live, crosses derived via USD, ECB reference toggle switches source and attribution |
| `packages/server/test/integration/portfolio/import.test.ts` | PORT-01/02: a CSV with a bad identifier yields `status='partial'`, an error row, and a `data_exceptions` entry; re-upload is idempotent |
| `packages/server/test/integration/portfolio/analytics.test.ts` | PORT-03..06: attribution sums to active return; VaR and tracking error against a golden portfolio |
| `packages/server/test/integration/portfolio/isolation.test.ts` | PORT-07: another firm's user gets 404, not 403-with-data |
| `packages/server/test/replay/fundamentals/companyfacts.test.ts` | QA-02: `sec-companyfacts-AAPL.json` → `xbrl_facts` → `fin_statements` is deterministic and idempotent; `mapping_version` recorded |
| `packages/web/test/screens/tier2/screens.test.tsx` | every Tier 2 `Screen.tsx` renders its payload fixture |

**Size:** XL — 12-15 agent-days.

---

### WP-11 — Tier 3 functions and the curve/rate/econ ingest

Ten codes (FUNCTIONS.md §6 L1098-1107): `YAS`, `CRVF` (alias `ICVS` → `curveId:'SOFR_OIS'`),
`WIRP`, `OVML`, `OMON`, `SWPM`, `SRCH`, `GC`, `FED`, `CRYP`.

**Owns**

```
packages/core/src/functions/manifests/{YAS,CRVF,WIRP,OVML,OMON,SWPM,SRCH,GC,FED,CRYP}.ts
packages/server/src/functions/{YAS,CRVF,WIRP,OVML,OMON,SWPM,SRCH,GC,FED,CRYP}/resolve.ts
packages/web/src/screens/{YAS,CRVF,WIRP,OVML,OMON,SWPM,SRCH,GC,FED,CRYP}/Screen.tsx
packages/server/src/ingest/jobs/{treasuryCurves,fedRates,fredSeries,blsSeries,worldMacro,econCalendar}.ts
packages/core/src/fields/defs/econ.ts
packages/server/test/integration/functions/{YAS,CRVF,WIRP,OVML,OMON,SWPM,SRCH,GC,FED,CRYP}.test.ts
packages/server/test/replay/rates/**
packages/web/test/screens/tier3/**
```

**Depends on:** WP-02 (every engine this tier calls), WP-08 (`ResolveContext`), WP-04
(`data/curves.ts`, `data/rates.ts`, `data/econ.ts`, `data/options.ts`, `refdata/terms.ts`),
WP-05 (the Treasury/Fed/FRED/BLS adapters), WP-12 (renderer).

**Builds**

- `YAS` over `govt_terms`: price↔yield, accrued, duration/convexity/DV01/key-rate durations,
  spread to the curve, cashflow table; every number comes back inside an `EngineResult` so
  `meta.engines[]` carries `{name, version, inputsHash}` (ANAL-01, ANAL-08).
- `CRVF`/`ICVS`: builds `UST_PAR`, `UST_BILL`, `UST_CMT`, `SOFR_FIX`, `SOFR_OIS` from
  `curve_points` and persists each build as a `curve_builds` row
  (`method`, `interpolation`, `engine_version`, `inputs_hash`, `inputs`, `nodes`), with date
  comparison; publishes `c:UST_PAR` / `c:SOFR_OIS` to the plant (ANAL-02).
- `WIRP`: FOMC-dated implied overnight path and 25 bp hike/cut probabilities from the money-market
  curve, against `fomc_meetings` (BRIEF §2 — no fed-funds futures source exists).
- `OVML` (variants `contract` and `underlying`), `OMON` (straddle chain by expiry using Cboe
  greeks/IV from `option_quotes`, ATM highlight, smile), `SWPM` (SOFR OIS), `SRCH`
  (Treasury screen by type/maturity/coupon/benchmark with yields from the curve), `GC` (curve on
  several dates plus a bp-change table), `FED` (policy range, EFFR/SOFR/IORB, FOMC calendar with
  implied moves, Fed press from `news_items` feed `press_all`), `CRYP` (context only, flagged
  `CONTEXT_ONLY_NOT_EXCHANGE_DATA` — FUNCTIONS.md §7.3 L1213-1308 is the normative worked example;
  reproduce it exactly).
- Six ingest jobs from PROVIDERS.b §13 writing `curve_points`, `govt_terms` (on-the-run bills by
  CUSIP), `rate_fixings`, `econ_observations` **with vintage detection** (a new value for an old
  `obs_date` opens a new `vintage_at` and flips `is_latest`), `econ_release_events` and
  `fomc_meetings`. `blsSeries` must issue **one POST** carrying every headline series id — the
  keyless tier allows 25 queries a day (PROVIDERS.b §10.5, and §17.5 open question).

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/server/test/integration/functions/YAS.test.ts` | the seven seeded on-the-run notes/bonds: price↔yield round-trip, accrued on a coupon date, KRDs sum to duration, `meta.engines[]` present |
| `packages/server/test/integration/functions/CRVF.test.ts` | a build reprices its inputs; the same inputs produce the same `inputs_hash` and reuse the `curve_builds` row; two dates compare |
| `packages/server/test/integration/functions/WIRP.test.ts` | probabilities sum to 1 per meeting; the path is flat when the curve is flat |
| `packages/server/test/integration/functions/OMON.test.ts` | chain from `cboe-options` (3,510 contracts) grouped by expiry with ATM identified; put-call ratio matches a hand count |
| `packages/server/test/integration/functions/SWPM.test.ts` | par rate zeroes the NPV; DV01 matches finite difference; schedule honours SIFMA |
| `packages/server/test/integration/functions/CRYP.test.ts` | reproduces the FUNCTIONS.md §7.3 worked example exactly, including the `CONTEXT_ONLY_NOT_EXCHANGE_DATA` badge |
| `packages/server/test/replay/rates/treasuryCurves.test.ts` | QA-02: `treasury-xml2` + `treasury-bills.xml` → ≈300 `curve_points` deterministically; re-run writes nothing |
| `packages/server/test/replay/rates/fedRates.test.ts` | `nyfed-*` + `fed-h15.csv` → `rate_fixings` with percentiles and volumes; a `revisionIndicator` opens a new vintage |
| `packages/server/test/replay/rates/fredSeries.test.ts` | vintage detection: replaying a changed value for an existing `obs_date` adds a vintage and flips `is_latest` exactly once |
| `packages/web/test/screens/tier3/screens.test.tsx` | every Tier 3 `Screen.tsx` renders its payload fixture |

**Size:** XL — 12-15 agent-days.

---

### WP-12 — Web shell, keyboard, command line, autocomplete and the screen renderer

**Owns**

```
packages/web/src/shell/**                 Shell.tsx PanelGrid.tsx Panel.tsx CommandLine.tsx
                                          Autocomplete.tsx StatusBar.tsx HelpOverlay.tsx TicketDialog.tsx
packages/web/src/keyboard/**              keymap.ts dispatcher.ts focus.ts
packages/web/src/command/**               localIndex.ts dispatch.ts
packages/web/src/state/**                 session.ts panels.ts workspace.ts subscriptions.ts settings.ts usage.ts
packages/web/src/screen/**                ScreenRenderer.tsx types.ts widgets/**
packages/web/src/format/index.ts
packages/web/src/export/csv.ts
packages/web/src/theme/colours.ts type.ts
packages/web/test/{shell,keyboard,command,state,screen}/**
```

(`theme/tokens.css`, `main.tsx`, `App.tsx` are WP-01's and are not edited here; the shell mounts at
the entry point WP-01 created.)

**Depends on:** WP-01 (SDK `RestClient`, `ScreenSpec` types), WP-03 (`UniverseIndex`, `parse`,
`rank`), WP-13 (`LiveClient`/`quoteCache` for the status bar — interface only).

**Builds** (FUNCTIONS.md §1.5 L369-473 for the client half of the framework, §2.5 L767-812 for
context rules, §2.6 L784-812 for reserved keys, §3.1 L859-888 for the local index)

- Shell: 1/2/4 panels, per-panel frame stack with back/forward, focus ring (TERM-04); workspace load
  and save through `PUT /workspaces/:workspaceId` carrying the `version` it read (409 on conflict, TERM-05).
- `CommandLine.tsx`: uncontrolled input, `<GO>` executes, parse problems shown against their span;
  `Autocomplete.tsx`: ≤12 ranked rows merging instruments, functions, people and topics
  (TERM-01/02); keystroke budget < 16 ms, autocomplete p95 < 80 ms (FUNCTIONS.md §3.5).
- `command/localIndex.ts`: loads `/universe/snapshot` into the core `UniverseIndex`, caches it in
  IndexedDB against the ETag, rebuilds MRU from history, builds in a Worker so the keystroke path
  never blocks.
- `command/dispatch.ts`: `Candidate` → panel action with the TERM-03 context rules
  (function-only applies to the panel's current security; security-only reloads the panel's current
  function), mints the `trace_id`, emits `fn.launch` / `search.select` usage events.
- `keyboard/*`: GO / CANCEL / MENU / HELP / PRINT / PAGE keys, Escape priority, typing-anywhere
  routing into the command line (TERM-06/07); `HELP` once explains the screen, twice opens a ticket
  (TERM-09).
- `screen/ScreenRenderer.tsx` + `widgets/` — the fixed widget set `Split, KeyValue, Grid, Table,
  Chart, Tabs, Form, Text, List, Badges, Custom` rendering a `ScreenSpec`; every `Cell` renders its
  `ValueState` distinctly (live / stale / closed / blank / na), and `Ctrl+I` opens the provenance
  panel for the cell's `meta.provenance[]` index (DATA-10, TERM-12). `Grid` delegates to WP-13's
  `LiveGrid` through a props contract; `Chart` delegates to WP-14's `ChartCanvas`.
- `StatusBar.tsx`: connection state, conflation ms, staleness legend, trace id, quota counters.
- `export/csv.ts`: PRINT calls the server export endpoint and never serialises locally (FUNC-03).
- `format/index.ts`: thin wrappers over `core/fields/format.ts` — the single formatter. **Domain and
  financial arithmetic lives in `packages/core` and is imported; the web package never re-implements
  it** (a returned percentage, a spread, a ratio, an adjusted price, a statistic). This is a review
  rule, not an ESLint rule: no lint rule can forbid arithmetic without banning `BinaryExpression`, which
  would make WP-13's virtualiser and per-cell flash maths and WP-14's scales, tick selection, crosshair
  projection and studies unlintable. Layout and pixel arithmetic in `packages/web` is expected and
  allowed. The enforceable zones stay exactly as §1.2 lists them: no `fetch`/`WebSocket`/
  `XMLHttpRequest` globals in `packages/web/src/**`, no imports from `packages/server/**`, no
  `process.env` outside `server/src/config.ts`.

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/web/test/command/localIndex.test.ts` | ETag/IndexedDB cache, Worker build, MRU rebuild from history (FUNCTIONS §8 row) |
| `packages/web/test/command/dispatch.test.ts` | the §2.5 context-rule table, frame stack, `fn.launch` event, trace id minting (FUNCTIONS §8 row) |
| `packages/web/test/keyboard/keymap.test.ts` | reserved keys, Escape priority, yellow keys, typing-anywhere routing (FUNCTIONS §8 row) |
| `packages/web/test/screen/renderer.test.tsx` | every `Node` kind keyboard-operable; each `Cell` state renders distinctly; provenance panel opens on `Ctrl+I` (FUNCTIONS §8 row) |
| `packages/web/test/shell/panels.test.tsx` | 1/2/4 layouts, per-panel frame stack, focus ring, workspace version conflict surfaces a 409 message |
| `packages/web/test/shell/commandline.test.tsx` | `AAPL US Equity DES` + GO dispatches; a parse problem highlights the right span |
| `packages/web/test/shell/autocomplete.bench.ts` | ranking + render under the 80 ms p95 budget on the 36 k-instrument snapshot |

**Size:** XL — 11-14 agent-days.

---

### WP-13 — LiveGrid, the SDK live client and the realtime bridge

**Owns**

```
packages/sdk/src/client/ws.ts subscriptions.ts quoteCache.ts      (stubs created by WP-01)
packages/web/src/grid/**                  LiveGrid.tsx GridModel.ts virtualiser.ts cellRegistry.ts
                                          flash.ts sort.ts group.ts keyboard.ts
packages/web/src/rt/wsBridge.ts
packages/sdk/test/client/**
packages/web/test/grid/**
```

**Depends on:** WP-01 (`wire/ws.ts`), WP-06 (the server side of the protocol — its tests are the
other half of these), WP-12 (the `Grid` widget delegates here).

**Builds** (API.md §10.2 L1283-1334 for the client surface, §6.3-6.7 for the rules it must obey;
ARCHITECTURE §6.6 L950-968 for the client pipeline)

- `LiveClient`: `hello`/`welcome`, `sub`/`unsub`, per-subject `lastSeq`, the **prev-chain check**
  (a `delta` whose `prev` ≠ the cached `seq` triggers a resync, never a silent apply), reconnect
  with backoff, `notice` and downgrade events, `LiveState` = `idle|connecting|open|resyncing|closed`.
- `SubscriptionManager`: ref-counted subscriptions, `sub`/`unsub` batched per animation frame, the
  `essential` flag driven by viewport visibility (BUS-04 co-operation).
- `QuoteCache`: `Map<subject, QuoteView>` applying `snap`/`delta` with the prev-chain rule and a
  1 s staleness ticker that calls `core/quote/staleness.ts` — the same function the server uses
  (TERM-12).
- `web/rt/wsBridge.ts`: `LiveClient` → `QuoteCache` → cell registry; gap/resync UI; one socket for
  the whole application.
- `LiveGrid` (TERM-08): virtualised rows, **imperative DOM cell updates** (no React re-render per
  tick), per-cell flash on change with direction colour, sort, group, keyboard navigation,
  column set driven by `GridColumn` from the `ScreenSpec`. Cells register in `cellRegistry.ts` by
  `(subject, fieldId)` so a delta touches only the cells that changed.

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/sdk/test/client/ws.test.ts` | handshake, sub/unsub, `prev`-chain gap → resync, reconnect backoff, `notice` surfaced — against the recorded exchange in API.md §6.8 |
| `packages/sdk/test/client/quoteCache.test.ts` | `snap` then `delta` produces the same state as a fresh `snap`; the 1 s ticker marks stale using the core function |
| `packages/sdk/test/client/subscriptions.test.ts` | ref counting, per-frame batching, `essential` toggling on viewport change |
| `packages/web/test/grid/liveGrid.test.tsx` | 1,000 rows × 12 columns: only changed cells are touched on a delta; flash applied and cleared |
| `packages/web/test/grid/frame-budget.bench.ts` | a burst of 5,000 field updates stays inside one animation frame budget (NFR-02) |
| `packages/web/test/grid/keyboard.test.tsx` | arrow/page navigation, sort toggling, group collapse, all keyboard-only |

**Size:** L — 8-10 agent-days.

---

### WP-14 — Chart engine and studies

**Owns**

```
packages/web/src/chart/**                 ChartCanvas.tsx renderer.ts scales.ts layers.ts series.ts
                                          streaming.ts events.ts annotations.ts studies/**
packages/web/test/chart/**
```

**Depends on:** WP-01 (`ChartSpec`, `ChartSeries`, `SeriesType` from the manifest types), WP-12
(the `Chart` widget delegates here), WP-13 (`QuoteCache` for the streaming last bar).

**Builds** (FUNCTIONS.md L439-476 fixes `ChartSpec`/`ChartSeries`/`SeriesType`; CHRT-01..07)

- A custom canvas renderer — **no chart library** (BRIEF §3). Device-pixel-ratio aware, one canvas
  per panel, redraw only dirty layers.
- Every `SeriesType` in the union: `line, area, mountain, candle, ohlc, bar, step, scatter, tick,
  pnf, profile, heatmap` (CHRT-01).
- Scales (linear, log, percent, indexed-to-100 normalisation), time axis with session gaps
  collapsed, multi-pane layout for studies, crosshair with value readout.
- Streaming: the forming `b1m:` bar updates in place without a full redraw (GIP).
- Events overlay: dividends, splits and filings from `corporate_actions` / `filings` on the time
  axis (CHRT-03).
- Annotations persisted to `chart_annotations` with the exact `kind` CHECK values
  `trendline|hline|vline|fib|text|regression_channel|rect` and `anchors` `[{t: epoch_ms, v}]`
  (regression: `{t0, t1, stdev}`) — CHRT-05.
- `studies/`: SMA, EMA, Bollinger, RSI, MACD, VWAP, ATR (the CHRT-04 subset). Study maths that is
  not display-only lives in `core/analytics/stats` (WP-02) and is imported, not reimplemented.

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/web/test/chart/renderer.test.ts` | golden-pixel snapshots (canvas → PNG hash) for each `SeriesType` on a fixed dataset. **Requires the `canvas ^3` devDependency added in §1.3** and registered in the `web` project's `setup.tsx`: jsdom ships no 2-D context, so `HTMLCanvasElement.getContext('2d')` returns `null` and every pixel golden throws on its first call without it. Same for `streaming.test.ts` and `chart.bench.ts`. If the native module cannot be built in CI, these three move to `packages/e2e` (Playwright, channel `chrome`) and WP-14's vitest files keep only the pure geometry modules (`scales.ts`, `series.ts`, `studies/**`) — a deliberate re-assignment, recorded here, not a skip |
| `packages/web/test/chart/scales.test.ts` | log/percent/indexed scales, session-gap collapsing, axis tick selection at three zoom levels |
| `packages/web/test/chart/streaming.test.ts` | the forming bar updates in place; a finalised bar (`IS_FINAL`) is not redrawn again |
| `packages/web/test/chart/annotations.test.ts` | CHRT-05: anchors survive a zoom/pan round-trip and serialise to the `chart_annotations.anchors` shape |
| `packages/web/test/chart/studies.test.ts` | each study against a hand-computed series; multi-pane layout |
| `packages/web/test/chart/chart.bench.ts` | 10 years of daily bars pans and zooms inside the frame budget |

**Size:** XL — 10-13 agent-days.

---

### WP-15 — Seed, fixtures, replay harness, e2e and traceability

**Owns**

```
packages/server/src/seed/{universe,bars,rates,curves,fundamentals,news,users,workspaces}.ts
packages/server/src/replay/**             harness.ts diff.ts cli.ts
fixtures/seed/**                          firms.json users.json entitlements.json workspaces.json
                                          treasuries.json concept-map.json fomc-2026.json
fixtures/sessions/**                      <name>/{events.ndjson,subscriptions.json,expected.ndjson}
packages/e2e/tests/**
packages/server/test/parity/**
docs/TESTING.md
docs/TRACEABILITY.md
```

(`seed/index.ts` and `seed/licences.ts` stay with WP-01; this package adds modules 2-13 of the
DATA_MODEL §18 table and the runner already calls them by directory order.)

**Depends on:** every other package for the full seed, but it starts immediately: modules 2-5
(calendars, universe, S&P 500, indices/FX/crypto) need only WP-04's `bitemporal.ts` and WP-05's
replay store, and the e2e specs are written against the documented UI contract before the UI exists.

**Builds**

- Twelve seed modules, offline, deterministic and idempotent, reading **only**
  `fixtures/providers/raw/*` through the replay store and `fixtures/seed/*.json`, so every seeded
  value carries a `provenance` row pointing at a fixture (DATA_MODEL §18 L2478-2507 gives the exact
  fixture → table → row-count mapping for each module; transcribe it, do not invent volumes).
  Target totals: ≈36 k instruments, ≈90 k identifiers, 503×2 index memberships, ≈1,450 daily bars,
  ≈1,110 intraday bars, 3,510 option contracts and quotes, ≈40 k XBRL facts, 1,275 filings,
  ≈17 k econ observations, 160 news items, 2 firms, 7 users, 7 workspaces.
- `replay/harness.ts` — plant session replay on a `VirtualClock`: `events.ndjson` →
  `plant.apply` → conflated frames → `actual.ndjson`; `replay/diff.ts` prints the **first**
  divergence against `expected.ndjson` and writes `dq_events.kind='replay_diff'`;
  `replay/cli.ts` backs `npm run replay:run` and `npm run replay:diff` (ARCHITECTURE §8.2 L1055-1071).
- The five session directories under `fixtures/sessions/` that TESTING §8 commits to, by those exact
  names: `cboe-aapl-poll` (the one recorded Cboe poll), `sim-ws-burst`, `sim-ws-backpressure`,
  `sim-ws-resync` and `fomc-release`. Only the first is fixture-derived; the `sim-*` three are generated
  by WP-05's deterministic `providers/sim/prng.ts` feed seeded from that snapshot, because
  `cboe-quote-AAPL.json` is a single poll (one `seqno`) and no second observation of any quote source
  exists on disk — a "market-open burst" cannot be recorded from it. (The earlier names `aapl-open`,
  `slow-consumer`, `gap-resync` are withdrawn; TESTING §8 is normative.)
- The seven Playwright specs of ARCHITECTURE §3.5 (L401-409) plus the smoke spec from WP-01.
- `packages/server/test/parity/fn-parity.test.ts` — every manifest × seed securities:
  JSON payload = CSV export = WS snapshot (API-05, FUNCTIONS §8 row).
- `docs/TESTING.md` **already exists** and is normative for test paths, the DB harness contract, the
  golden-update protocol and the CI matrix. WP-15 does not write it; WP-15 reconciles the acceptance
  tables of this plan to it and keeps it current as tests land.
- `docs/TRACEABILITY.md` — every requirement in REQUIREMENTS.md mapped to implemented (with test
  names), partially implemented (with the gap) or out of scope (with the reason), generated from
  the inline requirement citations (BRIEF §7).

**Acceptance tests**

| File | Proves |
| --- | --- |
| `packages/server/test/integration/seed/idempotent.test.ts` | `db:seed` twice writes zero rows the second time; every seeded value has a `provenance_id` resolving to a fixture |
| `packages/server/test/integration/seed/volumes.test.ts` | row counts per table match the DATA_MODEL §18 table within tolerance |
| `packages/server/test/replay/harness.test.ts` | a session replays bit-identically twice; an injected change produces exactly one reported divergence |
| `packages/server/test/parity/fn-parity.test.ts` | API-05 across every manifest and seeded security |
| `packages/e2e/tests/command-line.spec.ts` | `AAPL US Equity DES <GO>`, function-only and security-only input (TERM-01/03) |
| `packages/e2e/tests/autocomplete.spec.ts` | per-keystroke ranking under the 80 ms budget via `/api/v1/status` timings (TERM-02) |
| `packages/e2e/tests/panels.spec.ts` | four panels, back-stack, workspace persistence (TERM-04/05) |
| `packages/e2e/tests/live-grid.spec.ts` | QM flashes on a replayed session; staleness badge appears after the feed stops (TERM-08/12) |
| `packages/e2e/tests/export.spec.ts` | PRINT on HP yields a CSV equal to the screen values (FUNC-03) |
| `packages/e2e/tests/entitlement.spec.ts` | export denied shows the reason code; the `eod@demo` user sees frozen values (ENTL-05) |
| `packages/e2e/tests/help.spec.ts` | HELP once explains, twice opens a ticket (TERM-09) |

**Size:** L — 9-12 agent-days.

---

*(Sections 3-14 are the fourteen package entries of §2 above, one per WP-02 … WP-15. The numbering
below matches the cross-references used earlier in this document.)*

## 15. Integration and smoke checklist

Integration is not a phase at the end; each milestone below is a named test that becomes part of
`npm test` the moment its two packages are both merged, and the WP listed owns it.

| # | Milestone | Owner | Green when |
| --- | --- | --- | --- |
| I1 | **Schema ↔ ORM** | WP-01 | `migrate.test.ts` + `schema-drift.test.ts` pass on an empty `bloomberg_dev` and `bloomberg_test` |
| I2 | **Provider → provenance → table** | WP-05 + WP-04 | one adapter's replay run writes rows whose `provenance_id` resolves to a fixture, and a second run writes nothing |
| I3 | **Seed → resolve** | WP-15 + WP-04 | after `db:seed`, `AAPL US Equity`, `SPX Index`, `EURUSD Curncy`, `912797VE4 Govt` and one option contract all resolve to instruments with identifiers and md lines |
| I4 | **Ingest → plant → WebSocket** | WP-05 + WP-06 | `cboeQuotes` in replay mode raises a `q:` update that reaches a subscribed socket as `snap` then `delta` with correct `seq`/`prev` |
| I5 | **Entitlement in the path** | WP-07 + WP-06 + WP-08 | the same field is `allow` for `pm@demo` and `downgrade` for `eod@demo` on both REST and WS, and both write `access_log` rows |
| I6 | **Function end-to-end** | WP-08 + WP-09 | `POST /api/v1/functions/HP/run` for AAPL returns a payload whose `meta.provenance[]`, `meta.engines[]` and `meta.asOf` are populated, and `GET /functions/HP/csv` byte-matches the screen values |
| I7 | **SDK ↔ server protocol** | WP-13 + WP-06 | the SDK `LiveClient` drives a real server socket through subscribe → snapshot → delta → forced gap → resync |
| I8 | **Screen renders payload** | WP-12 + each tier WP | every `Screen.tsx` renders the payload its resolver produced for a seeded security, in jsdom, with no missing widget |
| I9 | **Grid under load** | WP-13 + WP-06 | a replayed session drives 1,000 rows without dropping a frame and flashes only changed cells |
| I10 | **Chart under load** | WP-14 + WP-09 | `GP SPX` renders 10 years of daily bars with events and studies; `GIP` streams a forming bar |
| I11 | **Parity** | WP-15 | `fn-parity.test.ts` green for all 38 manifests (API-05) |
| I12 | **Replay determinism** | WP-15 + WP-06 | `npm run replay:run` twice over every session in `fixtures/sessions/` produces identical output (FEED-08, QA-02) |
| I13 | **Traceability** | WP-15 | `TRACEABILITY.md` maps every REQUIREMENTS.md id to implemented / partial / out-of-scope with test names |

### 15.1 Smoke script (the BRIEF §7 definition of done)

Run on a clean clone, offline, with Postgres 14 up:

```
npm install
npm run db:reset && npm run db:migrate && npm run db:seed
npm run lint && npm run typecheck
npm test                       # unit + integration + replay + parity, PROVIDER_MODE=replay
npx playwright install chrome  # once
npm run test:e2e
npm run dev                    # server :8080, web :5173
```

Then, by hand in the browser — this is the acceptance walk-through:

1. Log in as `pm@demo`; the default 4-panel workspace loads (`WEI`, `TOP`, `GP SPX`, `W "Core"`).
2. Type `AAPL US Equity DES <GO>` — the description screen loads with live (delayed) quote fields
   flashing and a staleness legend in the status bar.
3. `GP <GO>` in the same panel — the chart loads for the panel's current security (TERM-03).
4. `QM <GO>` on the "MAG7" watchlist — cells flash; unplug the feed (`PROVIDER_MODE` circuit open)
   and the staleness badge appears within 3 × the expected interval (TERM-12).
5. `HP <GO>`, change the adjustment basis, press PRINT — the CSV downloads and matches the screen.
6. `Ctrl+I` on any number — the provenance panel shows source, capture time and the fixture URL.
7. `YAS` on `912797VE4 Govt`, `CRVF`, `OMON` on AAPL — analytics screens carry `meta.engines[]`.
8. `HELP` once, then twice — explanation, then a ticket with a helpdesk room.
9. Log in as `eod@demo` in a second browser — the same screens show frozen end-of-day values and a
   downgrade reason code; export is refused with a reason (ENTL-05).
10. `/api/v1/admin/trace/<trace-id>` from step 5 returns the access-log, usage-event and provenance
    rows for that one request (OPS-07).

## 16. Execution order and parallelism

**Wave 0 — WP-01 alone.** 8-12 days, one agent. Nothing else can start: every other package writes
files into directories WP-01 creates and imports types WP-01 defines.

**Wave 1 — everything else starts at once (14 agents).** The only *hard* blocks inside Wave 1 are
listed below; every other cross-package need is satisfied by a type or stub that already exists.

| Blocked work | Waits for | Days into Wave 1 (estimate) |
| --- | --- | --- |
| WP-04's five reference ingest jobs | WP-05 `providers/types.ts` + `http.ts` + `replayStore.ts` | ~3 |
| WP-05's reference-writing jobs | WP-04 `db/bitemporal.ts` | ~3 |
| WP-09/10/11 resolvers | WP-08 `functions/context.ts` (`ResolveContext`) | ~2 |
| WP-09/10/11 resolvers' data reads | WP-04 `data/*` services | ~5 |
| WP-09/10/11 screens rendering | WP-12 `ScreenRenderer` + widgets | ~6 |
| WP-11 resolvers | WP-02 engines (`curve`, `bond`, `options`, `wirp`) | ~6 |
| WP-13 SDK client tests | WP-06 `ws/gateway.ts` | ~5 |
| WP-12 autocomplete | WP-03 `rank.ts` + `index.ts`, WP-08 `/universe/snapshot` | ~4 |
| WP-15 full seed | WP-04 + WP-05 (modules 2-5 only need `bitemporal.ts` + replay store) | ~4 |
| WP-15 e2e specs | the whole of Wave 1 (specs are written first, enabled last) | end |

**Recommended sequencing inside Wave 1**, so the blocks above clear early:

- **Day 1-3 (critical path, do these first):** WP-05 `types.ts`/`http.ts`/`replayStore.ts`/
  `provenance.ts`; WP-04 `db/bitemporal.ts`; WP-08 `functions/context.ts` + `runner.ts`;
  WP-06 `plant/subjects.ts` + `tickerPlant.ts`; WP-12 `screen/types.ts` + `ScreenRenderer`
  skeleton; WP-02 `analytics/engine.ts` (`defineEngine`); WP-03 `ids/` + `command/tokenizer.ts`.
- **Day 3-8:** the bulk of each package, fully parallel.
- **Day 8-12:** first integration milestones I2-I7 as pairs land; tier packages move from manifests
  to resolvers to screens.
- **Day 12-18:** WP-09/10/11 screens, WP-14 studies, WP-15 seed volumes and the parity test;
  milestones I8-I13.

**Sharding advice.** Three packages are large enough to split across two agents with disjoint file
sets: WP-05 by adapter directory (each has its own `adapter.ts`/`parse.ts`/golden), WP-09 as 09A
(functions) + 09B (news/messaging/alerts), WP-10 and WP-11 by function code. No shard may touch
another shard's directory.

**Wave 2 — hardening (all agents, 3-5 days).** Fuzz corpora, bench budgets (autocomplete p95,
grid frame budget, chart pan/zoom), `TRACEABILITY.md`, `TESTING.md`, the `npm run test:live` pass
against real providers, and the §15.1 walk-through on a clean machine.

## 17. File-ownership index

Authoritative. Every source path in the repository maps to exactly one WP. `→ WP-nn` after a
WP-01 entry means "created by WP-01, owned by WP-nn from then on".

| Path glob | Owner |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig*.json`, `eslint.config.js`, `.prettier*`, `.env.example`, `.gitignore`, `vitest.config.ts` (root, `test.projects`) | WP-01 |
| `scripts/**` | WP-01 |
| `packages/*/package.json`, `packages/*/tsconfig.json` | WP-01 |
| `packages/core/src/index.ts`, `clock.ts`, `types/**`, `fields/dictionary.ts`, `fields/format.ts` | WP-01 |
| `packages/core/src/fields/defs/index.ts` | GENERATED (`gen:fields`) — the generator is WP-01's |
| `packages/core/src/functions/{manifest,registry,csv}.ts`, `hash/**` | WP-01 |
| `packages/core/src/functions/manifests/index.ts` | GENERATED (glob) — the generator is WP-01's |
| `packages/core/src/fields/defs/{analytic,derived}.ts` | WP-02 |
| `packages/core/src/fields/defs/reference.ts` | WP-03 |
| `packages/core/src/fields/defs/price.ts` | WP-06 |
| `packages/core/src/fields/defs/news.ts` | WP-09 |
| `packages/core/src/fields/defs/{fundamental,portfolio}.ts` | WP-10 |
| `packages/core/src/fields/defs/econ.ts` | WP-11 |
| `packages/core/src/{calendars,daycount,analytics,adjust}/**` | WP-02 |
| `packages/core/src/{ids,text,command,search,formula}/**` | WP-03 |
| `packages/core/src/quote/**` | WP-06 |
| `packages/core/src/functions/manifests/<TIER1 CODE>.ts` (14) | WP-09 |
| `packages/core/src/functions/manifests/<TIER2 CODE>.ts` (14) | WP-10 |
| `packages/core/src/functions/manifests/<TIER3 CODE>.ts` (10) | WP-11 |
| `packages/sdk/src/index.ts`, `wire/{envelope,ws,dataRequest,reasonCodes}.ts`, `fields/**`, `functions/**`, `client/rest.ts` | WP-01 |
| `packages/sdk/src/wire/rest/{reference,search,functions,data,fields,status,workspaces}.ts` | WP-01 → WP-08 |
| `packages/sdk/src/wire/rest/{auth,usage,admin}.ts` | WP-01 → WP-07 |
| `packages/sdk/src/wire/rest/{news,messages,alerts,watchlists,help}.ts` | WP-01 → WP-09 |
| `packages/sdk/src/wire/rest/portfolios.ts` | WP-01 → WP-10 |
| `packages/sdk/src/wire/rest/index.ts` | GENERATED (glob) |
| `packages/sdk/src/client/{ws,subscriptions,quoteCache}.ts` | WP-01 → WP-13 |
| `packages/server/drizzle.config.ts`, `drizzle/migrations/0001-0016*.sql`, `src/db/{client.ts,schema/**}`, `src/config.ts`, `src/app.ts`, `src/index.ts` | WP-01 |
| `packages/server/src/providers/licences.ts`, `src/seed/{index,licences}.ts`, `src/test/**` | WP-01 |
| `packages/server/src/http/{trace,errors}.ts`, `http/routes/health.ts` | WP-01 → WP-08 |
| `packages/server/src/plant/tickerPlant.ts`, `src/ws/gateway.ts` | WP-01 → WP-06 |
| `packages/server/src/functions/runner.ts` | WP-01 → WP-08 |
| `packages/server/src/db/bitemporal.ts`, `src/refdata/**`, `src/data/**` | WP-04 |
| `packages/server/src/providers/**` (except `licences.ts`), `src/ingest/{scheduler,lock,hotset}.ts`, `src/db/partitions.ts`, `src/observability/dq.ts` | WP-05 |
| `packages/server/src/ingest/jobs/{symbologyRefresh,universeSymbolBook,secNport,ssgaHoldings,shortInterest}.ts` | WP-04 |
| `packages/server/src/ingest/jobs/{cboeQuotes,cboeEuIndices,cboeOptions,yahooIntraday,yahooDaily,fxIntraday,fxEod,crypto,partitionMaintenance,retentionPurge,dqMonitors,reconcile}.ts` | WP-05 |
| `packages/server/src/ingest/jobs/usageDeclarations.ts` | WP-07 |
| `packages/server/src/ingest/jobs/newsRss.ts` | WP-09 |
| `packages/server/src/ingest/jobs/{secSubmissions,secCompanyFacts,secFrames}.ts` | WP-10 |
| `packages/server/src/ingest/jobs/{treasuryCurves,fedRates,fredSeries,blsSeries,worldMacro,econCalendar}.ts` | WP-11 |
| `packages/server/src/ingest/jobs/index.ts` | GENERATED (glob) |
| `packages/server/src/{plant,ws}/**` (including `plant/store.ts`, the only writer of `quote_ticks`, `quote_snapshots` and `eod_snapshots`) | WP-06 |
| `packages/server/src/entitlements/**`, `src/http/auth/**`, `http/routes/{auth,usage,admin}.ts` | WP-07 |
| `packages/server/src/functions/{context,resultCache,export}.ts`, `src/search/**`, `src/observability/{logger,metrics,usageEvents,traceQuery}.ts` | WP-08 |
| `packages/server/src/http/routes/{data,functions,export,fields,reference,search,universe,status,workspaces}.ts` | WP-08 |
| `packages/server/src/http/routes/{news,messages,alerts,watchlists,help}.ts`, `src/{news,messaging}/**`, `src/alerts/engine.ts` | WP-09 |
| `packages/server/src/http/routes/portfolios.ts`, `src/portfolio/service.ts` | WP-10 |
| `packages/server/src/http/routes/index.ts`, `src/functions/index.ts` | GENERATED (glob) |
| `packages/server/src/functions/<TIER1 CODE>/resolve.ts` | WP-09 |
| `packages/server/src/functions/<TIER2 CODE>/resolve.ts` | WP-10 |
| `packages/server/src/functions/<TIER3 CODE>/resolve.ts` | WP-11 |
| `packages/server/src/replay/**`, `src/seed/**` (except `index.ts`, `licences.ts`) | WP-15 |
| `packages/web/index.html`, `vite.config.ts`, `src/{main.tsx,App.tsx}`, `src/theme/tokens.css` | WP-01 |
| `packages/web/src/{shell,keyboard,command,state,screen,format,export}/**`, `src/theme/{colours,type}.ts` | WP-12 |
| `packages/web/src/{grid,rt}/**` | WP-13 |
| `packages/web/src/chart/**` | WP-14 |
| `packages/web/src/screens/<TIER1 CODE>/Screen.tsx` | WP-09 |
| `packages/web/src/screens/<TIER2 CODE>/Screen.tsx` | WP-10 |
| `packages/web/src/screens/<TIER3 CODE>/Screen.tsx` | WP-11 |
| `packages/web/src/screens/index.ts` | GENERATED (glob) |
| `packages/e2e/playwright.config.ts`, `fixtures/serverProcess.ts` | WP-01 |
| `packages/e2e/tests/**` | WP-15 (smoke spec seeded by WP-01) |
| `fixtures/providers/manifest.json` | GENERATED (`fixtures:import`) |
| `fixtures/providers/normalised/**` | WP-05 |
| `fixtures/golden/analytics/**` | WP-02 |
| `fixtures/seed/**`, `fixtures/sessions/**` | WP-15 |
| `docs/{TESTING,TRACEABILITY}.md` | WP-15 (TESTING.md already exists and is normative for test paths — WP-15 maintains, it does not author it) |
| `docs/WORKPLAN.md` §18 | append-only by any WP (§0.4) |

Test trees follow their package: `packages/core/test/{calendars,daycount,analytics,adjust}` → WP-02;
`{ids,command,search,formula}` → WP-03; `quote` → WP-06; `{fields,functions,hash}` → WP-01.
The TESTING.md files no glob above claimed:
`packages/server/test/integration/{pit.fundamentals,curves.build}.test.ts` → WP-04, `…/bitemporal.test.ts` → WP-01;
`…/integration/functions/HP.adjust.test.ts` → WP-09; `…/integration/functions/YAS.golden.test.ts` → WP-11;
`packages/server/test/replay/{requestKey,manifest,import,normalisers,no-network}.test.ts` → WP-05;
`packages/server/test/replay/{sessions,determinism}.test.ts` → WP-15 (§0.2).
`packages/server/test/integration/functions/<CODE>.test.ts` follows the code's tier package.

## 18. Additions required

Everything here is needed by this plan and is **not** defined in CONTRACTS.md. Append-only; sign
new entries with the WP that raised them.

1. **`core/src/fields/defs/*.ts` + a glob-generated `defs/index.ts`.** ARCHITECTURE L197 specifies
   a single `core/src/fields/dictionary.ts`. A single file would be edited by seven packages, which
   violates the exclusive-ownership rule this plan is built on. The dictionary is therefore split
   by `field_class` — the eight values of the `field_class` enum — with `dictionary.ts` assembling
   the generated barrel. `scripts/gen-fields.ts` must glob `defs/*.ts` instead of reading one file.
   *(WP-01)*
2. **CONTRACTS.md has two incomplete extractions, and one ambiguity, that this plan works around.**
   Do not build from the digest in these three places — read the cited API.md / FUNCTIONS.md range
   instead (§1.7 says so at the point of use):
   - **§2.1 Routes lists 11 routes; API.md declares about 106.** The digest script parsed only the
     paths that happened to sit inside fenced code blocks and missed the §5 markdown route tables
     entirely, plus §1.3's 12 auth routes and §9's export endpoints. `GET /ref/resolve`,
     `POST /functions/:code/run`, `GET /universe/snapshot` and some ninety others are absent. The
     full set is §1.3's 12, the ~90 rows of §5.1-5.15 (multi-method rows written `GET / PUT / DELETE`
     count once per method), §9's five export endpoints and `/ws/v1`. (PROVIDERS.b §16.11 already
     flags a comparable digest defect for elided CHECK lists, so the pattern is known.)
   - **§2.2 WebSocket message types lists 9 of 20.** The union is `hello, sub, unsub, resync,
     conflation, essential, ping` | `welcome, subAck, snap, delta, status, batch, downgrade, resync,
     notice, alert, msg, err, pong, bye`, plus the §6.7 close-code table. API.md §6.2 L868-915 is
     normative.
   - **§3.1 and §4.1 both declare the function framework, with incompatible generics.**
     ARCHITECTURE L710 gives `FunctionManifest<P, T = unknown>` and omits `aliasParams`, `variants`
     and `payloadVersion`; FUNCTIONS.md L115 gives `FunctionManifest<P, T extends { variant: string }
     = { variant: string }>` and has all three. `ResolveContext` is split the same way (ARCHITECTURE
     L674 has `role: 'user'|'admin'`; FUNCTIONS L220 has the six-value union matching the `users.role`
     CHECK, and only its `page` carries `set(info)`). **FUNCTIONS.md is normative for the function
     framework** — manifest, `defineFunction`, payload, CSV, screen and `ResolveContext` — and
     ARCHITECTURE §5.1/§5.2 are informative copies. WP-01 builds `core/src/functions/manifest.ts` from
     the FUNCTIONS.md ranges and keeps the `T extends { variant: string }` bound, without which
     WP-08's runner ("choose the variant by `asset_class`") and every polymorphic resolver lose the
     variant assertion FUNCTIONS §8 requires. *(plan author)*
3. **Two more generated barrels.** ARCHITECTURE L90-91 has `gen-function-index.ts` emit three
   barrels. `server/src/ingest/jobs/index.ts` is marked GENERATED at L290 with no generator named,
   and `server/src/http/routes/index.ts` does not exist at all — but `app.ts` must be frozen after
   WP-01 or every route-owning package edits it. Both are added to `gen-function-index.ts`. *(WP-01)*
4. **`IngestJob.id` = module basename** (`cboeQuotes`, not `cboe.quotes.poll`). Carried from
   PROVIDERS.b §16.2; ARCHITECTURE L975 and DATA_MODEL L2104 disagree with each other and both need
   the correction. *(WP-05)*
5. **Shared provider parsers** `providers/{xml,html,csv}.ts` and `providers/ssga/xlsx.ts`. The
   ARCHITECTURE module map lists only `adapter.ts`/`parse.ts` per provider directory. Carried from
   PROVIDERS.b §16.5. All four are pure and are QA-05 fuzz targets. *(WP-05)*
6. **`core/src/ids/cik.ts`** (`pad`/`unpad`) — `data.sec.gov` and `/Archives` disagree about CIK
   padding. Carried from PROVIDERS.b §16.8. *(WP-03)*
7. **`core/src/text/normName.ts`** and **`server/src/refdata/newsDict.ts`** — the shared name
   normaliser and the per-run matcher dictionary. Carried from PROVIDERS.b §16.6-16.7. *(WP-03, WP-04)*
8. **`ingest/jobs/cboeEuIndices.ts`** — ARCHITECTURE §7.1 has no row for it; PROVIDERS.b §13 does.
   Carried from PROVIDERS.b §16.4. *(WP-05)*
9. **A WebAuthn implementation choice.** SEC-02 requires FIDO2 registration and assertion
   (`http/auth/webauthn.ts`, `user_credentials.public_key`/`sign_count`/`aaguid`/`transports`) but
   no dependency is named in any spine document. Proposal: `@simplewebauthn/server ^13`, added to
   `packages/server` by WP-01 so the lockfile is written once. *(WP-07)*
10. **Four scripts not in the ARCHITECTURE `scripts/` listing** (L89-93, which names only
    `gen-function-index.ts`, `gen-fields.ts`, `fixtures-import.ts`) but required by the root script
    table at L83-85: `scripts/migrate.ts`, `scripts/seed.ts`, `scripts/reset.ts` and
    `scripts/fixtures-urls.ts` (the `FIXTURE_URLS` table, also required by PROVIDERS.b §16.9-16.10).
    *(WP-01)*
11. **Migration filenames.** DATA_MODEL identifies migrations by number and topic, not by filename.
    The sixteen names in §1.4 are fixed by this plan; `drizzle/migrations/NNNN_<name>.sql` is the
    only pattern ARCHITECTURE L244 gives. *(WP-01)*
12. **Two runtime dependencies with no home in the docs:** `@fastify/cookie` (cookie sessions are
    specified in API.md §1 but no plugin is named) and `npm-run-all2` (the root `dev` script must
    run server and web concurrently). Both are added by WP-01. *(WP-01)*
13. **No `ingest_jobs` table exists**; the job table is `IngestJob[]` in `ingest/jobs/index.ts` and
    only `ingest_runs` is persisted. Carried from PROVIDERS.b §16.1. *(WP-05)*
14. **`fixtures/providers/raw/` holds 48 entries**, not the 50 stated in BRIEF §2 and
    ARCHITECTURE L97 (corrected there and in TESTING §8; TESTING now asserts "every file present",
    not a literal). `scripts/fixtures-import.ts` imports what is on disk. **Four** captures are
    missing, each with its exact URL, and re-capturing them is a WP-05 task:
    `https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/USA` (IMF observations),
    `https://feeds.bloomberg.com/wealth/news.rss` (the sixth `bbg.rss` feed; record the post-redirect
    `www.bloomberg.com/feeds/…` URL as the request key),
    `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` (FOMC calendar) and
    `https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=max&interval=1d&events=div%7Csplit`
    (AAPL daily history with splits — the recorded `max` capture returned `dataGranularity 3mo`, which
    is why WP-02's AAPL adjustment golden is currently demoted to published closes). *(WP-01, WP-05)*
15. **Nightly EQS factors.** `EQS` is specified as screening over "`xbrl_frames`, nightly factors"
    (FUNCTIONS.md §6) but CONTRACTS.md defines no factor table and no factor job. Either the factors
    are computed on read from `xbrl_frames` + `bars_daily` (this plan's assumption) or a
    `0017_wp10_factors.sql` table is required. *(WP-10)*
16. **The golden analytics datasets do not exist.** QA-01 requires golden datasets
    `{inputs, valuationTs, expected}` per engine and case, but no expected values exist anywhere in
    the spine documents. WP-02 must derive them from published worked examples (Treasury bill
    formulas, ICMA bond conventions, textbook BSM/CRR cases) and record the source of each case in
    the file, not from its own implementation's output. *(WP-02)*

## 19. Open questions

Ones that change a work package's scope. The first four are carried from PROVIDERS.b §17 because
they block specific acceptance tests named above.

1. ~~**The `openfigi-map` capture's shape**~~ — **closed, no re-capture needed.** The file was parsed:
   it is a two-element array, job 0 returning **1** composite row (`exchCode: 'US'`,
   `figi BBG000B9XRY4`, `shareClassFIGI BBG001S5N8V8`) and job 1 returning **275** venue rows
   (`exchCode` values `US, UN, UP, UA, UC, …`). DATA_MODEL §3.1 L535 is correct and the FIXTURES.md
   digest ("two jobs × one row") is wrong and should be corrected there. WP-05's `openfigi/parse.ts`
   golden asserts 1 + 275, and WP-15's `listings` seed volume stands.
2. **`finra-trace` is short-interest data, not TRACE** — the fixture name is misleading and
   `FIXTURE_URLS` must map it to `consolidatedShortInterest`. No TRACE endpoint is used in v1.
3. ~~**The SPDR `Identifier` column's scheme**~~ — **closed.** The workbook was opened: the header row
   is `Name, Ticker, Identifier, SEDOL, Weight, Sector, Shares Held, Local Currency`, and `Identifier`
   is CUSIP (AAPL `037833100`, NVDA `67066G104`, MSFT `594918104`) with SEDOL in its own column
   (AAPL `2046251`, GOOGL `BYVY8G0`). No per-row scheme sniff is needed; `ssgaHoldings` reads
   `Identifier` as CUSIP and `SEDOL` as SEDOL, subject to the placeholder rule in WP-04. The `Sector`
   column is the literal `-` and must not be read as a classification.
4. **`bls.timeseries` keyless series-per-query limit** — the multi-series POST in WP-11's
   `blsSeries` is unverified against the live endpoint; if the cap is lower, the job splits into two
   or three queries a day and its golden changes.
5. ~~**Is the `realtime` tier reachable at all in v1?**~~ — **closed: yes, for three sources.**
   PROVIDERS.b §15 gives `max_tier = realtime` to `nyfed.rates`, `internal.derived` and
   `internal.user`; published fixings are not delayed quotes. So the positive test case for
   `plant/policyTier.view(state,'realtime')` is `r:SOFR` (and the `q:` subject of the SOFR instrument),
   and any `internal.derived` value (a curve point, a computed statistic) is a second. WP-06's
   `ws/entitlement.test.ts` and WP-07's `evaluator.test.ts` use `nyfed.rates` for the `realtime`
   positive case and any Cboe/Yahoo subject for the negative one, which is what distinguishes
   `NOT_ENTITLED_TIER` (the grant is too low) from `SOURCE_TIER_CAP` (the source is capped at
   `delayed`). No synthetic source is required.
6. **Who owns a field id that two tiers both need?** The `defs/*.ts` split is by `field_class`, but
   e.g. `CUR_MKT_CAP` is arguably `derived` (WP-02) and `fundamental` (WP-10). The rule adopted
   here is "the `field_licence.field_class` value decides", which means `field_licence` seeding
   (WP-01) settles ownership — this needs confirming against the real dictionary once written.
7. **`quote_ticks.conditions` has no source.** FEED-07 is a placeholder: no reachable provider
   publishes sale conditions, and the documented values are `'delayed'`, `'synthetic_from_poll'`.
   WP-06 should confirm nothing downstream (QM, Q's tape) renders a condition the feed cannot supply.
8. **Option-chain subject cardinality.** `cboeOptions` produces 3,510 AAPL contracts; each is a
   `q:` subject with its own `QuoteState`. Whether the plant holds every contract or only those with
   a subscriber (with `oc:` carrying the summary) changes WP-06's memory profile and WP-05's
   `cboeOptions` write volume. ARCHITECTURE L1000 implies subscriber-gated; confirm before I4.
9. **Where does `search_weight` come from?** `instruments.search_weight` is documented as an
   autocomplete prior ("index members > 1; Cboe-only symbols < 1") but no formula is given. WP-15's
   seed must fix one, and WP-03's ranking tests depend on it being deterministic.
10. **Does `GIP`'s forming bar come from the plant or from the chart's own subscription?**
    `b1m:<instrumentId>` is a plant subject with `IS_FINAL`, and WP-14 streams it; the contract
    between `ChartSpec` and the `QuoteCache` for the forming bar is not written down anywhere.
    WP-13 and WP-14 must agree it before I10.
