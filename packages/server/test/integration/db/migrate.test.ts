/**
 * WORKPLAN §1.11 — "migrate on an empty database creates every table, enum, view, trigger and
 * function named in CONTRACTS §1.2/§1.3, asserted by querying `information_schema` / `pg_trigger` /
 * `pg_proc` against a checked-in list".
 *
 * The database really is empty: `beforeAll` creates a throwaway database next to `bloomberg_test`
 * and applies `drizzle/migrations/*.sql` into it in name order, one transaction per file — the
 * order and the framing `scripts/migrate.ts` uses. Asserting against `bloomberg_test` instead would
 * only prove that `globalSetup.ts` ran; it would not prove the migrations are self-sufficient on a
 * fresh cluster, which is the claim this file exists to make.
 *
 * The lists below are transcribed from CONTRACTS.md §1.1 (enum types), §1.2 (tables) and §1.3 (SQL
 * functions, views, triggers). They are deliberately literal: a migration that renames or drops an
 * object has to be reconciled with the digest here, in this file, by hand. The same lists carry the
 * objects the Drizzle mirror cannot model — SQL functions, triggers, exclusion constraints and the
 * partitioned parents — which `schema-drift.test.ts` allowlists and this file proves exist.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testDatabaseUrl } from '../../../src/test/db.js';

const { Client } = pg;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/migrations/', import.meta.url));

// ── CONTRACTS §1.1 — enum types and their labels, in declaration order ────────────────────────
const CONTRACT_ENUMS: Readonly<Record<string, readonly string[]>> = {
  asset_class: [
    'equity',
    'etf',
    'index',
    'fx',
    'govt',
    'option',
    'future',
    'crypto',
    'rate',
    'econ',
  ],
  market_sector: [
    'Equity',
    'Index',
    'Curncy',
    'Govt',
    'Corp',
    'Comdty',
    'Mtge',
    'Muni',
    'Pfd',
    'M-Mkt',
    'Crypto',
  ],
  id_scheme: [
    'FIGI',
    'COMPOSITE_FIGI',
    'SHARE_CLASS_FIGI',
    'ISIN',
    'CUSIP',
    'SEDOL',
    'RIC',
    'TICKER_EXCH',
    'LEI',
    'MIC',
    'CIK',
    'OCC',
    'PROVIDER_SYMBOL',
    'SERIES_CODE',
  ],
  tier: ['eod', 'delayed', 'realtime'],
  usage_type: ['display', 'export', 'api'],
  field_class: [
    'price',
    'reference',
    'fundamental',
    'econ',
    'news',
    'analytic',
    'derived',
    'portfolio',
  ],
  entl_decision: ['allow', 'downgrade', 'deny'],
  ca_type: [
    'cash_dividend',
    'special_dividend',
    'stock_dividend',
    'split',
    'reverse_split',
    'spinoff',
    'merger',
    'tender',
    'rights',
    'call',
    'conversion',
    'name_change',
    'ticker_change',
    'delisting',
    'capital_return',
  ],
  ca_status: ['estimated', 'announced', 'confirmed', 'paid', 'cancelled'],
  entity_kind: ['issuer', 'issue', 'instrument', 'listing', 'person', 'topic'],
  session_state: ['pre', 'open', 'auction', 'halted', 'closed', 'post', 'unknown'],
};

// ── CONTRACTS §1.2 — every table, in digest order ─────────────────────────────────────────────
const CONTRACT_TABLES: readonly string[] = [
  'provenance',
  'licence_registry',
  'field_licence',
  'issuers',
  'issues',
  'instruments',
  'listings',
  'md_lines',
  'identifiers',
  'issuer_aliases',
  'exchanges',
  'govt_terms',
  'option_terms',
  'future_terms',
  'fund_terms',
  'index_terms',
  'fx_terms',
  'rate_terms',
  'calendars',
  'calendar_sessions',
  'calendar_holidays',
  'classification_schemes',
  'classification_codes',
  'entity_classifications',
  'indices',
  'index_members',
  'people',
  'entity_relations',
  'corporate_actions',
  'quote_ticks',
  'quote_snapshots',
  'bars_intraday',
  'bars_daily',
  'eod_snapshots',
  'option_quotes',
  'vol_surfaces',
  'xbrl_facts',
  'xbrl_frames',
  'xbrl_concept_map',
  'filings',
  'fin_statements',
  'etf_holdings',
  'short_interest',
  'econ_releases',
  'econ_release_events',
  'econ_series',
  'econ_observations',
  'fomc_meetings',
  'rate_fixings',
  'fx_rates',
  'curves',
  'curve_points',
  'curve_builds',
  'topics',
  'news_items',
  'news_entity_links',
  'firms',
  'users',
  'user_credentials',
  'sessions',
  'api_keys',
  'entitlement_grants',
  'access_log',
  'usage_declarations',
  'quota_limits',
  'quota_counters',
  'quota_instruments_seen',
  'workspaces',
  'watchlists',
  'watchlist_items',
  'chart_annotations',
  'saved_searches',
  'portfolios',
  'portfolio_imports',
  'positions',
  'lots',
  'alerts',
  'alert_events',
  'rooms',
  'room_members',
  'messages',
  'message_reads',
  'legal_holds',
  'message_reviews',
  'surveillance_lexicon',
  'surveillance_hits',
  'usage_events',
  'help_tickets',
  'ingest_runs',
  'dq_events',
  'data_exceptions',
  'status_incidents',
  'config_versions',
  'schema_meta',
];

// ── CONTRACTS §1.3 — SQL functions (L88-L2385) ────────────────────────────────────────────────
const CONTRACT_FUNCTIONS: readonly string[] = [
  'tier_rank',
  'bt_as_of',
  'bt_guard_update',
  'bt_close_tx',
  'set_updated_at',
  'app_user_id',
  'app_firm_id',
  'app_role',
  'assert_source_known',
  'bump_config_version',
  'worm_block',
  'messages_chain',
  'is_room_member',
  'room_has_firm',
];

// ── CONTRACTS §1.3 — the six `*_now` views ────────────────────────────────────────────────────
const CONTRACT_VIEWS: readonly string[] = [
  'issuers_now',
  'issues_now',
  'instruments_now',
  'listings_now',
  'md_lines_now',
  'identifiers_now',
];

// ── CONTRACTS §1.3 — every trigger and the function it calls ──────────────────────────────────
const CONTRACT_TRIGGERS: Readonly<Record<string, string>> = {
  licence_registry_bt_guard: 'bt_guard_update',
  provenance_source_known: 'assert_source_known',
  field_licence_source_known: 'assert_source_known',
  issuers_bt_guard: 'bt_guard_update',
  issues_bt_guard: 'bt_guard_update',
  instruments_bt_guard: 'bt_guard_update',
  listings_bt_guard: 'bt_guard_update',
  md_lines_bt_guard: 'bt_guard_update',
  md_lines_source_known: 'assert_source_known',
  identifiers_bt_guard: 'bt_guard_update',
  govt_terms_bt_guard: 'bt_guard_update',
  option_terms_bt_guard: 'bt_guard_update',
  future_terms_bt_guard: 'bt_guard_update',
  fund_terms_bt_guard: 'bt_guard_update',
  index_terms_bt_guard: 'bt_guard_update',
  fx_terms_bt_guard: 'bt_guard_update',
  rate_terms_bt_guard: 'bt_guard_update',
  calendars_source_known: 'assert_source_known',
  classification_schemes_source_known: 'assert_source_known',
  entity_classifications_bt_guard: 'bt_guard_update',
  index_members_bt_guard: 'bt_guard_update',
  people_bt_guard: 'bt_guard_update',
  entity_relations_bt_guard: 'bt_guard_update',
  corporate_actions_bt_guard: 'bt_guard_update',
  econ_releases_source_known: 'assert_source_known',
  econ_series_source_known: 'assert_source_known',
  curves_source_known: 'assert_source_known',
  news_items_source_known: 'assert_source_known',
  workspaces_updated: 'set_updated_at',
  watchlists_updated: 'set_updated_at',
  portfolios_updated: 'set_updated_at',
  chart_annotations_updated: 'set_updated_at',
  saved_searches_updated: 'set_updated_at',
  licence_registry_bump: 'bump_config_version',
  field_licence_bump: 'bump_config_version',
  entitlement_grants_bump: 'bump_config_version',
  calendar_holidays_bump: 'bump_config_version',
  messages_worm: 'worm_block',
  access_log_worm: 'worm_block',
  provenance_worm: 'worm_block',
  usage_events_worm: 'worm_block',
  xbrl_facts_worm: 'worm_block',
  messages_chain_trg: 'messages_chain',
};

/**
 * The GiST exclusion constraints of the bitemporal tables (DATA_MODEL §1.2). Drizzle 0.45 cannot
 * express `EXCLUDE USING gist … WHERE (tx_to = 'infinity')`, so `schema-drift.test.ts` allowlists
 * them and this file is where they are proved to exist.
 */
const EXCLUSION_CONSTRAINTS: readonly string[] = [
  'corporate_actions_bt_excl',
  'corporate_actions_natural_excl',
  'entity_classifications_bt_excl',
  'entity_relations_bt_excl',
  'fund_terms_bt_excl',
  'future_terms_bt_excl',
  'fx_terms_bt_excl',
  'govt_terms_bt_excl',
  'identifiers_bt_excl',
  'index_members_bt_excl',
  'index_terms_bt_excl',
  'instruments_bt_excl',
  'issuers_bt_excl',
  'issues_bt_excl',
  'licence_registry_bt_excl',
  'listings_bt_excl',
  'md_lines_bt_excl',
  'md_lines_symbol_excl',
  'option_terms_bt_excl',
  'people_bt_excl',
  'rate_terms_bt_excl',
];

/** The six `PARTITION BY RANGE` parents (DATA_MODEL §15.d.1). */
const PARTITIONED_PARENTS: readonly string[] = [
  'access_log',
  'bars_daily',
  'bars_intraday',
  'option_quotes',
  'quote_ticks',
  'usage_events',
];

/** The four extensions migration 0001 requires; none of them is TimescaleDB or pgvector. */
const REQUIRED_EXTENSIONS: readonly string[] = ['btree_gist', 'pg_trgm', 'pgcrypto', 'uuid-ossp'];

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `postgres://host/bloomberg_test` → the same server, a different database. */
function urlForDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * A private database per worker process: the integration project runs up to four forks and
 * `CREATE DATABASE` is cluster-wide.
 */
const SCRATCH_DB = `bloomberg_migrate_probe_${process.pid}`;

let scratch: pg.Client;
const applied: string[] = [];

async function withAdmin(fn: (admin: pg.Client) => Promise<void>): Promise<void> {
  const admin = new Client({ connectionString: urlForDatabase(testDatabaseUrl(), 'postgres') });
  await admin.connect();
  try {
    await fn(admin);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  // `testDatabaseUrl()` refuses anything whose database name does not contain "test"; the scratch
  // name is derived from a constant, never from the environment, and is quoted below regardless.
  expect(SCRATCH_DB).toMatch(/^[a-z0-9_]+$/);
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
  });

  scratch = new Client({ connectionString: urlForDatabase(testDatabaseUrl(), SCRATCH_DB) });
  await scratch.connect();
  for (const file of migrationFiles()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
    await scratch.query('BEGIN');
    try {
      await scratch.query(sql);
      await scratch.query('COMMIT');
    } catch (err) {
      await scratch.query('ROLLBACK').catch(() => undefined);
      throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    applied.push(file);
  }
}, 180_000);

afterAll(async () => {
  await scratch?.end().catch(() => undefined);
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  });
}, 60_000);

async function names(sql: string, params: readonly unknown[] = []): Promise<string[]> {
  const res = await scratch.query<{ name: string }>(sql, params as unknown[]);
  return res.rows.map((r) => r.name);
}

describe('migrations apply to an empty database', () => {
  it('applies the sixteen migration files in name order', () => {
    expect(applied).toHaveLength(16);
    expect(applied[0]).toBe('0001_extensions_enums.sql');
    expect(applied.at(-1)).toBe('0016_partitions_initial.sql');
    expect([...applied].sort()).toEqual(applied);
  });

  it('installs the four required extensions', async () => {
    const installed = await names('SELECT extname AS name FROM pg_extension');
    for (const ext of REQUIRED_EXTENSIONS) expect(installed).toContain(ext);
  });
});

describe('CONTRACTS §1.1 — enum types', () => {
  it('creates exactly the eleven enum types', async () => {
    const found = await names(`
      SELECT t.typname AS name
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'`);
    expect(found.sort()).toEqual(Object.keys(CONTRACT_ENUMS).sort());
  });

  it('creates every label, in declaration order', async () => {
    const res = await scratch.query<{ name: string; labels: string[] }>(`
      -- enumlabel is of type "name"; the ::text cast makes the aggregate a text[], which the pg
      -- driver parses into a JavaScript array instead of handing back the literal '{a,b,c}'.
      SELECT t.typname AS name,
             array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE n.nspname = 'public' AND t.typtype = 'e'
       GROUP BY t.typname`);
    const actual = new Map(res.rows.map((r) => [r.name, r.labels]));
    for (const [enumName, labels] of Object.entries(CONTRACT_ENUMS)) {
      expect(actual.get(enumName), enumName).toEqual([...labels]);
    }
  });
});

describe('CONTRACTS §1.2 — tables', () => {
  it('creates exactly the ninety-four tables', async () => {
    // `relkind IN ('r','p')` counts the partitioned parents; `relispartition` drops the children,
    // which are data, not schema (0016 seeds an initial set and the maintenance job adds more).
    const found = await names(`
      SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`);
    expect(CONTRACT_TABLES).toHaveLength(94);
    expect(found.sort()).toEqual([...CONTRACT_TABLES].sort());
  });

  it('exposes every one of them through information_schema.tables', async () => {
    const found = await names(`
      SELECT table_name AS name
        FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    for (const table of CONTRACT_TABLES) expect(found).toContain(table);
  });

  it('gives every table at least one column', async () => {
    const res = await scratch.query<{ name: string; n: string }>(`
      SELECT table_name AS name, count(*)::text AS n
        FROM information_schema.columns
       WHERE table_schema = 'public'
       GROUP BY table_name`);
    const counts = new Map(res.rows.map((r) => [r.name, Number(r.n)]));
    for (const table of CONTRACT_TABLES) {
      expect(counts.get(table) ?? 0, table).toBeGreaterThan(0);
    }
  });
});

describe('CONTRACTS §1.3 — views', () => {
  it('creates the six `*_now` views', async () => {
    const found = await names(`
      SELECT table_name AS name FROM information_schema.views WHERE table_schema = 'public'`);
    expect(found.sort()).toEqual([...CONTRACT_VIEWS].sort());
  });
});

describe('CONTRACTS §1.3 — functions', () => {
  it('creates every named function in pg_proc', async () => {
    // Extension-owned functions (pg_trgm, btree_gist, pgcrypto, uuid-ossp) live in `public` too,
    // so the set is checked by containment, not equality.
    const found = await names(`
      SELECT DISTINCT p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'`);
    for (const fn of CONTRACT_FUNCTIONS) expect(found, fn).toContain(fn);
  });

  it('declares the trigger functions as RETURNS trigger and the predicates as IMMUTABLE', async () => {
    const res = await scratch.query<{ name: string; rettype: string; volatile: string }>(
      `
      SELECT p.proname AS name, pg_catalog.format_type(p.prorettype, NULL) AS rettype,
             p.provolatile AS volatile
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [CONTRACT_FUNCTIONS as string[]],
    );
    const byName = new Map(res.rows.map((r) => [r.name, r]));
    for (const fn of [
      'bt_guard_update',
      'assert_source_known',
      'worm_block',
      'messages_chain',
      'set_updated_at',
      'bump_config_version',
    ]) {
      expect(byName.get(fn)?.rettype, fn).toBe('trigger');
    }
    // `bt_as_of` and `tier_rank` are IMMUTABLE so the planner can inline them into partial indexes.
    expect(byName.get('bt_as_of')?.volatile).toBe('i');
    expect(byName.get('tier_rank')?.volatile).toBe('i');
  });
});

describe('CONTRACTS §1.3 — triggers', () => {
  it('creates exactly the forty-three named triggers', async () => {
    const found = await names(`
      SELECT DISTINCT t.tgname AS name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
    expect(Object.keys(CONTRACT_TRIGGERS)).toHaveLength(43);
    expect(found.sort()).toEqual(Object.keys(CONTRACT_TRIGGERS).sort());
  });

  it('wires every trigger to the function CONTRACTS names', async () => {
    const res = await scratch.query<{ name: string; fn: string }>(`
      SELECT DISTINCT t.tgname AS name, p.proname AS fn
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
    const byName = new Map(res.rows.map((r) => [r.name, r.fn]));
    for (const [trigger, fn] of Object.entries(CONTRACT_TRIGGERS)) {
      expect(byName.get(trigger), trigger).toBe(fn);
    }
  });
});

describe('objects the Drizzle mirror cannot model', () => {
  it('creates every GiST exclusion constraint', async () => {
    const found = await names(`
      SELECT k.conname AS name
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND k.contype = 'x'`);
    expect(found.sort()).toEqual([...EXCLUSION_CONSTRAINTS].sort());
  });

  it('declares the six partitioned parents in pg_partitioned_table', async () => {
    const found = await names(`
      SELECT c.relname AS name
        FROM pg_partitioned_table pt
        JOIN pg_class c ON c.oid = pt.partrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'`);
    expect(found.sort()).toEqual([...PARTITIONED_PARENTS].sort());
  });

  it('gives each partitioned parent an initial partition set and a default partition', async () => {
    const res = await scratch.query<{ parent: string; child: string }>(`
      SELECT p.relname AS parent, c.relname AS child
        FROM pg_inherits i
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = 'public'`);
    for (const parent of PARTITIONED_PARENTS) {
      const children = res.rows.filter((r) => r.parent === parent).map((r) => r.child);
      expect(children.length, parent).toBeGreaterThan(0);
      expect(children, parent).toContain(`${parent}_default`);
    }
  });

  it('enables row-level security on the nineteen tenant-scoped tables', async () => {
    const secured = await names(`
      SELECT c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relrowsecurity`);
    const policied = await names(
      `SELECT DISTINCT tablename AS name FROM pg_policies WHERE schemaname = 'public'`,
    );
    expect(secured.sort()).toEqual(policied.sort());
    expect(secured.length).toBeGreaterThanOrEqual(19);
  });
});

describe('the migration ledger', () => {
  it('records nothing by itself — `schema_meta` exists and is empty on a raw apply', async () => {
    // `scripts/migrate.ts` owns the ledger; applying the raw SQL (as this test does) writes none of
    // it, which is exactly why the runner buffers filenames until 0014 creates `schema_meta`.
    const res = await scratch.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_meta WHERE key LIKE 'migration:%'`,
    );
    expect(res.rows[0]?.n).toBe('0');
  });
});
