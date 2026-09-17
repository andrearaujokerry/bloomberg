/**
 * The Drizzle schema barrel — hand-written, owned by WP-01, and changed only when a migration
 * changes. `db/client.ts` passes `import * as schema from './schema/index.js'` to `drizzle()`,
 * and `test/integration/db/schema-drift.test.ts` walks these exports with `getTableConfig()`.
 *
 * Module order follows the migrations (0001 → 0014) so that the dependency direction of the
 * foreign keys is the same here as it is in the SQL.
 *
 * Objects the mirror deliberately does not carry — SQL functions, triggers, exclusion
 * constraints, `PARTITION BY RANGE`, the `*_now` views, roles and RLS policies — live only in
 * `drizzle/migrations/*.sql` and are covered by the drift test's allowlist.
 */

// 0001 — enum types (pgEnum, declared once).
export * from './enums.js';

// 0002 — provenance and the licence registry.
export * from './provenance.js';

// 0003 — security master (issuers, issues, instruments, listings, identifiers).
export * from './reference.js';

// 0004 — instrument terms (equity, fixed income, option, future, fx, crypto, index).
export * from './terms.js';

// 0005 — calendars, sessions and classifications.
export * from './calendars.js';

// 0006 — corporate actions.
export * from './corporateActions.js';

// 0007 — market data (quotes, trades, bars, daily closes).
export * from './timeseries.js';

// 0008 — fundamentals (XBRL facts, frames, statements, estimates).
export * from './fundamentals.js';

// 0009 — economic releases, series, observations and rate fixings.
export * from './econ.js';

// 0009 — curves, curve points and cached curve builds.
export * from './curves.js';

// 0010 — news topics, items and entity links.
export * from './news.js';

// 0011 — firms, users, credentials, sessions and API keys.
export * from './users.js';

// 0011 — entitlement grants, the access log, usage declarations and quotas.
export * from './entitlements.js';

// 0012 — workspaces, watchlists, chart annotations and saved searches.
export * from './workspace.js';

// 0012 — portfolios, imports, positions and lots.
export * from './portfolio.js';

// 0012 — alerts and alert events.
export * from './alerts.js';

// 0013 — rooms, the WORM message log, legal holds and surveillance.
export * from './messaging.js';

// 0014 — usage events, help tickets, ingest runs, DQ events, exceptions, status and config.
export * from './ops.js';
