# DATA_MODEL — final Postgres 14 data model (committed SQL migrations)

This is the binding data model for the terminal clone described in [BRIEF.md](./BRIEF.md),
[REQUIREMENTS.md](./REQUIREMENTS.md) and [ARCHITECTURE.md](./ARCHITECTURE.md). It merges the three
candidate models under `docs/design/candidate-{A,B,C}/DATA_MODEL.md`: the bitemporal machinery,
column naming and current-version-only exclusion come from A (as ratified in ARCHITECTURE §4.3 and
§15), the `licence_registry`/`field_licence` naming, `DEFAULT` partitions and the per-room hash-chain
trigger from B and C, the vintage/`is_latest` econ pattern and `curve_builds` cache from C. Where the
candidates disagreed, or were wrong for Postgres 14, the choice is recorded in §20.

Every statement below is the literal content of a migration file under
`packages/server/drizzle/migrations/` (ARCHITECTURE §3.3), applied in order by `npm run db:migrate`
(Drizzle migrator, `drizzle.config.ts` → `out: ./drizzle/migrations`). The Drizzle table definitions
under `packages/server/src/db/schema/*.ts` mirror the columns one-to-one for typed queries; anything
Drizzle cannot express (exclusion constraints, partitions, generated columns, RLS, triggers, grants)
exists only in the SQL and is referenced from TypeScript through `sql` tags. **The SQL is the
authority; the Drizzle schema is a projection of it** (§21). A test
(`packages/server/test/integration/schema.mirror.test.ts`) introspects `information_schema.columns`
against the Drizzle metadata and fails on any drift. Every migration block below was executed in
order against a scratch Postgres 14.17 database before this document was committed.

| Migration file | Contents | Drizzle schema file(s) |
| --- | --- | --- |
| `0001_extensions_enums.sql` | extensions, enums, bitemporal helper functions, guard trigger, `app_*()` session helpers | — (`db/bitemporal.ts`) |
| `0002_provenance_licence.sql` | `licence_registry`, `field_licence`, `provenance` | `schema/provenance.ts` |
| `0003_security_master.sql` | `issuers`, `issues`, `instruments`, `listings`, `md_lines`, `identifiers`, `*_now` views | `schema/reference.ts` |
| `0004_terms.sql` | `govt_terms`, `option_terms`, `future_terms`, `fund_terms`, `index_terms`, `fx_terms`, `rate_terms` | `schema/terms.ts` |
| `0005_calendars_classifications.sql` | `exchanges`, `calendars`, `calendar_sessions`, `calendar_holidays`, classification tables, `indices`, `index_members`, `people`, `entity_relations`, `issuer_aliases` | `schema/calendars.ts`, `schema/reference.ts` |
| `0006_corporate_actions.sql` | `corporate_actions` | `schema/corporateActions.ts` |
| `0007_market_data.sql` | `bars_daily`, `bars_intraday`, `quote_ticks`, `option_quotes`, `quote_snapshots`, `eod_snapshots`, `fx_rates`, `short_interest`, `etf_holdings`, `vol_surfaces` | `schema/timeseries.ts` |
| `0008_fundamentals.sql` | `filings`, `xbrl_facts`, `xbrl_frames`, `xbrl_concept_map`, `fin_statements` | `schema/fundamentals.ts` |
| `0009_econ_curves.sql` | `econ_releases`, `econ_series`, `econ_observations`, `rate_fixings`, `econ_release_events`, `fomc_meetings`, `curves`, `curve_points`, `curve_builds` | `schema/econ.ts`, `schema/curves.ts` |
| `0010_news.sql` | `topics`, `news_items`, `news_entity_links` | `schema/news.ts` |
| `0011_users_entitlements.sql` | `firms`, `users`, `user_credentials`, `sessions`, `api_keys`, `entitlement_grants`, `access_log`, `usage_declarations`, quota tables | `schema/users.ts`, `schema/entitlements.ts` |
| `0012_workspace_portfolio.sql` | `workspaces`, `watchlists`, `watchlist_items`, `portfolios`, `positions`, `lots`, `portfolio_imports`, `chart_annotations`, `saved_searches`, `alerts`, `alert_events` | `schema/workspace.ts`, `schema/portfolio.ts`, `schema/alerts.ts` |
| `0013_messaging.sql` | `rooms`, `room_members`, `messages`, `message_reads`, `legal_holds`, `surveillance_lexicon`, `surveillance_hits`, `message_reviews` | `schema/messaging.ts` |
| `0014_ops.sql` | `usage_events`, `help_tickets`, `dq_events`, `ingest_runs`, `data_exceptions`, `status_incidents`, `schema_meta`, `config_versions` | `schema/ops.ts` |
| `0015_roles_rls_worm.sql` | `terminal_app` role, grants, RLS policies, WORM triggers, hash chain | — |
| `0016_partitions_initial.sql` | the partitions the seed window needs (generated; see §16) | — (`db/partitions.ts`) |

---

## 0. Conventions

| Convention | Rule |
| --- | --- |
| Entity ids | `bigint` from a dedicated sequence per entity (`instrument_id_seq`, …). Immutable for the life of the entity and never reused (REF-01). Never a ticker; never a FIGI (FIGIs are reassigned on corporate events, and rates/econ series/T-bills have no FIGI — ARCHITECTURE §15). Exposed on the wire as JSON numbers. |
| Version rows | Bitemporal tables have `version_id bigserial PRIMARY KEY` plus the entity id. A logical entity is the set of its version rows; foreign keys between bitemporal tables point at the entity id (`instrument_id`), never at a `version_id`, and are enforced by the `refdata/*` repositories plus the nightly `dq_events` check `ref_orphans`, not by `REFERENCES` (a versioned target has no unique entity key). |
| Surrogate ids | Non-bitemporal, non-partitioned tables use `bigint GENERATED ALWAYS AS IDENTITY`. **Partitioned tables use an explicit sequence** (`DEFAULT nextval('<table>_id_seq')`): Postgres 14 rejects identity columns on partitioned tables (`identity columns are not supported on partitioned tables`, lifted only in PG 17). |
| Time | All timestamps are `timestamptz` (UTC). Calendar facts (`session_date`, `ex_date`, `period_end`, `filed_at`, `maturity_date`) are `date`. |
| Numbers | Prices `numeric(18,6)`; rates and yields **in percent** `numeric(12,8)` (4.83 means 4.83 %); factors `numeric(20,12)`; money `numeric(28,6)`; weights as fractions `numeric(12,10)`. Never `float`/`double precision` in stored market data (API-05 needs bit-identical values on every surface). |
| Provenance | Every row that holds a sourced value has `provenance_id bigint NOT NULL REFERENCES provenance(provenance_id)` (DATA-10). Derived rows (`fin_statements`, `curve_builds`, `vol_surfaces`) carry `provenance_ids bigint[]`. |
| Codes | `source_id` values are the adapter ids listed in ARCHITECTURE §7.1/§9 (`'cboe.quotes'`, `'yahoo.chart'`, `'sec.companyfacts'`, …). `field_id` values are ids from `packages/core/src/fields/dictionary.ts`. |
| Naming | snake_case; plural table names; `_at` for timestamps, `_date` for dates; partitions `<table>_y2026`, `<table>_m2026_09`, `<table>_d2026_09_15`, `<table>_default`. |
| Bitemporal marker | `-- [BT]` inside a `CREATE TABLE` stands for exactly the block in §1.2, expanded verbatim in the migration file. |
| App role | The server connects as `terminal_app` (never the owner), so row-level security and the WORM revokes in §15 apply to every query the application can issue. Migrations and the seed run as the owner. Per-request transactions call `set_config('app.user_id'|'app.firm_id'|'app.role', …, true)` (§15.1). |
| Migration blocks | Every fenced block whose first line is `-- migration: NNNN_<name>.sql` is migration content; other SQL blocks are worked queries or examples and are not applied. |

---

## 1. Migration 0001 — extensions, enums, bitemporal machinery (REF-03)

### 1.1 DDL

```sql
-- migration: 0001_extensions_enums.sql
CREATE EXTENSION IF NOT EXISTS btree_gist;     -- '=' on scalar keys inside gist exclusion constraints
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- trigram indexes for autocomplete fallback and headline search
CREATE EXTENSION IF NOT EXISTS pgcrypto;       -- digest() for the message hash chain, session token hashing
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";    -- uuid_generate_v4() kept available; gen_random_uuid() is core in PG14

CREATE TYPE asset_class   AS ENUM ('equity','etf','index','fx','govt','option','future','crypto','rate','econ');
CREATE TYPE market_sector AS ENUM ('Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto');
CREATE TYPE id_scheme     AS ENUM ('FIGI','COMPOSITE_FIGI','SHARE_CLASS_FIGI','ISIN','CUSIP','SEDOL','RIC','TICKER_EXCH',
                                   'LEI','MIC','CIK','OCC','PROVIDER_SYMBOL','SERIES_CODE');
CREATE TYPE tier          AS ENUM ('eod','delayed','realtime');            -- declared in rank order: eod < delayed < realtime
CREATE TYPE usage_type    AS ENUM ('display','export','api');
CREATE TYPE field_class   AS ENUM ('price','reference','fundamental','econ','news','analytic','derived','portfolio');
CREATE TYPE entl_decision AS ENUM ('allow','downgrade','deny');
CREATE TYPE ca_type       AS ENUM ('cash_dividend','special_dividend','stock_dividend','split','reverse_split','spinoff',
                                   'merger','tender','rights','call','conversion','name_change','ticker_change',
                                   'delisting','capital_return');
CREATE TYPE ca_status     AS ENUM ('estimated','announced','confirmed','paid','cancelled');
CREATE TYPE entity_kind   AS ENUM ('issuer','issue','instrument','listing','person','topic');
CREATE TYPE session_state AS ENUM ('pre','open','auction','halted','closed','post','unknown');

-- Tier ordering for the entitlement evaluator and tests (min(cap, firm, user) is min(tier_rank)).
CREATE FUNCTION tier_rank(t tier) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE t WHEN 'eod' THEN 0 WHEN 'delayed' THEN 1 WHEN 'realtime' THEN 2 END $$;

-- 1.1.a The as-of predicate (REF-03). IMMUTABLE so it is inlined by the planner and usable in partial indexes.
CREATE FUNCTION bt_as_of(vf timestamptz, vt timestamptz, tf timestamptz, tt timestamptz,
                         valid_at timestamptz, known_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT vf <= valid_at AND vt > valid_at AND tf <= known_at AND tt > known_at
$$;

-- 1.1.b Guard: application code may UPDATE a bitemporal row only to close tx_to, exactly once.
CREATE FUNCTION bt_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tx_to <> 'infinity' THEN
    RAISE EXCEPTION 'bitemporal row % in % is already closed', OLD.version_id, TG_TABLE_NAME;
  END IF;
  IF NEW.tx_to = 'infinity' THEN
    RAISE EXCEPTION 'bitemporal rows in % are immutable; insert a new version', TG_TABLE_NAME;
  END IF;
  IF NEW.tx_to <= OLD.tx_from THEN
    RAISE EXCEPTION 'tx_to must be after tx_from';
  END IF;
  -- every column except tx_to must be unchanged
  IF (to_jsonb(NEW) - 'tx_to') <> (to_jsonb(OLD) - 'tx_to') THEN
    RAISE EXCEPTION 'only tx_to may change on a bitemporal row in %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

-- 1.1.c Generic "close current versions overlapping a valid range" used by writeVersion() (one implementation
-- for every bitemporal table; EXECUTE with format(%I) so the table/key are identifiers, values are parameters).
-- p_now defaults to clock_timestamp(), NOT now(): now() is transaction start, so a version inserted and then closed
-- in one transaction would get tx_to = tx_from and raise 'tx_to must be after tx_from' (bt_guard_update) as well as
-- violating <table>_tx_range. clock_timestamp() advances within the transaction, so two writes to one key in one
-- transaction still order. Callers that are backdating (a historical correction, a seed) pass p_now explicitly.
CREATE FUNCTION bt_close_tx(tbl regclass, key_col text, key_val bigint, p_valid_from timestamptz, p_valid_to timestamptz,
                            p_now timestamptz DEFAULT clock_timestamp())
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  EXECUTE format(
    'UPDATE %s SET tx_to = $4 WHERE %I = $1 AND tx_to = ''infinity''
       AND tstzrange(valid_from, valid_to, ''[)'') && tstzrange($2, $3, ''[)'')', tbl, key_col)
    USING key_val, p_valid_from, p_valid_to, p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- 1.1.d Session context helpers used by every RLS policy (§15). NULLIF guards the '' that current_setting()
-- returns for a custom GUC that was set earlier in the session and has since gone out of scope.
CREATE FUNCTION app_user_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::bigint $$;
CREATE FUNCTION app_firm_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.firm_id', true), '')::bigint $$;
CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'none') $$;
```

### 1.2 The bitemporal column block (`-- [BT]`), normative (ARCHITECTURE §4.3)

Expanded verbatim inside every table marked `-- [BT]`; `<table>` and `<key>` are substituted:

```sql
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT <table>_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT <table>_tx_range    CHECK (tx_from < tx_to),
  -- at most one CURRENT version per key and valid instant. Closed transaction versions may overlap in valid time
  -- by design (that is what a correction is), so the exclusion is restricted to tx_to = 'infinity' (ARCHITECTURE §15).
  CONSTRAINT <table>_bt_excl EXCLUDE USING gist (<key> WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&)
    WHERE (tx_to = 'infinity')
```

and after the table:

```sql
CREATE INDEX <table>_current_idx ON <table> (<key>) WHERE tx_to = 'infinity';
CREATE TRIGGER <table>_bt_guard BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION bt_guard_update();
-- DELETE is revoked from terminal_app on every bitemporal table in 0015.
```

Valid time = when the fact was true in the world. Transaction time = when we recorded it. Rows are
never updated in place except to close `tx_to`. Deletion is a closed `tx_to`. The column *default* for
`tx_from` is `now()` (transaction start), which is what an ordinary ingest write wants: every version
written in one transaction then shares one `known_at`. Two things override it. (1) A caller that knows the
real knowledge instant — a filing's `acceptanceDateTime`, a corporate action's announcement — passes it
explicitly as `VersionWrite.txFrom` (§1.3); backdating transaction time is the whole point of REF-03 and
is impossible if the column default is the only way to set it. (2) Closing a version uses
`clock_timestamp()`, not `now()`, so a write and its close inside one transaction do not collapse to the
same instant (§1.1.c).
`btree_gist` supplies the `=` operator class for `bigint`, `text` and enum keys inside the GiST
exclusion (enum support exists since PG 11), so `entity_kind WITH =` and `scheme WITH =` are legal.

### 1.3 Write semantics — `packages/server/src/db/bitemporal.ts`

```ts
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Tx } from './client';

export interface BitemporalColumns { validFrom: PgColumn; validTo: PgColumn; txFrom: PgColumn; txTo: PgColumn; provenanceId: PgColumn; versionId: PgColumn }
export type BitemporalTable<Row = unknown> = PgTable & BitemporalColumns & { $entityKey: string /* 'instrument_id' */ };
export type BitemporalKeys = 'validFrom' | 'validTo' | 'txFrom' | 'txTo' | 'provenanceId';

export interface AsOf { validAt: Date; knownAt: Date }
export const nowAsOf = (clock: { now(): number }): AsOf => { const d = new Date(clock.now()); return { validAt: d, knownAt: d }; };

/** WHERE fragment: the version valid at validAt as known at knownAt (REF-03). The ONLY read predicate refdata/* offers. */
export function asOf(t: BitemporalColumns, at: AsOf): SQL {
  return sql`bt_as_of(${t.validFrom}, ${t.validTo}, ${t.txFrom}, ${t.txTo}, ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)`;
}
/** Current, currently-believed rows; hits the <table>_current_idx partial index. */
export function current(t: BitemporalColumns): SQL {
  return sql`${t.txTo} = 'infinity' AND ${t.validTo} = 'infinity'`;
}

export interface VersionWrite<Row> {
  entityKey: Partial<Row>;                       // { instrumentId: 42 } — the <key> column(s) of the exclusion constraint
  validFrom: Date; validTo?: Date;               // default 'infinity'
  data: Omit<Row, BitemporalKeys | 'versionId'>;
  provenanceId: number;
  reason: 'initial' | 'change' | 'correction';   // audit label written to data_exceptions on conflict; mechanics identical
  /** knownAt: the instant this became known to us. Written to tx_from of the new row AND passed as bt_close_tx's
   *  p_now, so the closed version's tx_to equals the new version's tx_from and the transaction-time axis has no
   *  gap and no overlap. Omitted → clock_timestamp() (the ordinary "we learned it now" case). REQUIRED whenever
   *  the knowledge instant is historical: SEC acceptanceDateTime, a Yahoo event date, any seeded history
   *  (REF-09/STOR-06 both depend on it). Must be strictly greater than the tx_from of the version being closed —
   *  bt_guard_update rejects NEW.tx_to <= OLD.tx_from — and not in the future. */
  txFrom?: Date;
}
/**
 * In ONE transaction (caller supplies tx):
 *  1. bt_close_tx(table, key, [validFrom, validTo)) closes every current version overlapping the new valid range.
 *  2. For each closed row whose valid range sticks out of [validFrom, validTo), re-insert the non-overlapping
 *     remainders [old.valid_from, validFrom) and [validTo, old.valid_to) as new rows with the OLD data and
 *     provenance and the same tx_from as step 3.
 *  3. Insert the new row with tx_from = w.txFrom ?? clock_timestamp(). The exclusion constraint proves no two
 *     current rows overlap.
 * Steps 1 and 2 use the same instant as step 3, so two versions of one key may be written in ONE transaction
 * (an initial value and a later correction, as the seed does): the first close sets tx_to = the second row's
 * tx_from. With now() they would collide, because now() is transaction start.
 * A CHANGE (coupon effective from D) passes validFrom = D and narrows the old version; a CORRECTION
 * ("we were wrong all along") passes the old valid range and gets the same valid range with a later tx_from.
 * Never issues UPDATE on a data column. Returns the new version_id.
 */
export async function writeVersion<Row>(tx: Tx, table: BitemporalTable<Row>, w: VersionWrite<Row>): Promise<number>;
/** No-op (returns null) when the current version for entityKey/validFrom has identical `data` — ingest idempotency. */
export async function upsertVersion<Row>(tx: Tx, table: BitemporalTable<Row>, w: VersionWrite<Row>): Promise<number | null>;
```

Tables whose exclusion key is composite (`identifiers`, `entity_classifications`, `index_members`,
`entity_relations`) call `bt_close_tx` once per key column set through a table-specific wrapper in
`refdata/*` (the generic function takes one bigint key; the wrappers issue the equivalent `UPDATE …
WHERE k1 = $1 AND k2 = $2 AND tx_to = 'infinity' AND range && range`).

### 1.4 Worked acceptance query (REF-03) — `packages/server/test/integration/bitemporal.test.ts`

```sql
-- 2026-03-01: we record note 91282CJK8 with coupon 4.500 (provenance 1, reason 'initial')
-- 2026-03-10: source correction: the coupon was always 4.250 (provenance 2, reason 'correction')
-- "What did we believe the coupon was on 14 March, as of what we knew on 5 March?"  → 4.500
SELECT g.coupon_rate
FROM govt_terms g
JOIN identifiers i ON i.entity_kind = 'instrument' AND i.entity_id = g.instrument_id
                  AND i.scheme = 'CUSIP' AND i.value = '91282CJK8'
WHERE bt_as_of(g.valid_from, g.valid_to, g.tx_from, g.tx_to, '2026-03-14', '2026-03-05T12:00Z')
  AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to, '2026-03-14', '2026-03-05T12:00Z');
-- the same query with known_at = '2026-03-12' → 4.250
```

---

## 2. Migration 0002 — provenance and the licence registry (DATA-09, DATA-10, STOR-07)

The DDL fixed in ARCHITECTURE §9, reproduced with its indexes, triggers and the seed rule.

```sql
-- migration: 0002_provenance_licence.sql
CREATE TABLE provenance (                       -- DATA-10: one row per raw provider exchange (= one replay-store entry)
  provenance_id   bigserial PRIMARY KEY,
  source_id       text NOT NULL,                -- licence_registry.source_id (validity enforced by trigger below)
  request_key     text NOT NULL,                -- replay store key: sha256(providerId|METHOD|url-sorted-query|sha256(body)) hex (ARCHITECTURE §8.1)
  request_url     text NOT NULL,
  request_hash    bytea NOT NULL,               -- sha256(method + url + body)
  response_sha256 bytea NOT NULL,
  http_status     int NOT NULL,
  bytes           int NOT NULL,
  captured_at     timestamptz NOT NULL,         -- FEED-05 'cap'
  source_ts       timestamptz,                  -- provider-published time when present ('src'); Cboe top-level `timestamp` (UTC)
  adapter_version text NOT NULL,                -- 'cboe/1.0.0'
  trace_id        uuid,                         -- when fetched on behalf of a request (OPS-07)
  run_id          bigint                        -- ingest_runs.run_id when fetched by the scheduler (FK added in 0014)
);
CREATE INDEX provenance_source_captured_idx ON provenance (source_id, captured_at DESC);
CREATE INDEX provenance_request_key_idx    ON provenance (request_key, captured_at DESC);
CREATE INDEX provenance_trace_idx          ON provenance (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX provenance_run_idx            ON provenance (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE licence_registry (                 -- DATA-09: machine-readable terms per source; bitemporal because terms change
  version_id      bigserial PRIMARY KEY,
  source_id       text NOT NULL,                -- 'cboe.quotes','cboe.options','cboe.symbolBook','cboe.euIndices','yahoo.chart','yahoo.search',
                                                -- 'openfigi.mapping' (one row for both /v3/mapping and /v3/search, PROVIDERS.b §6.2),
                                                -- 'sec.tickers','sec.submissions','sec.companyfacts','sec.frames',
                                                -- 'sec.atom','sec.archives','fred.csv','fred.calendar','nyfed.rates','fed.h15','fed.rss','fed.fomc',
                                                -- 'treasury.yieldcurve','treasury.bills','bls.timeseries','bls.schedule','worldbank','imf.datamapper',
                                                -- 'frankfurter','finra.shortInterest','bbg.rss','coingecko.simple','ssga.holdings','wiki.sp500',
                                                -- 'internal.derived' (curves, statistics, standardised statements), 'internal.user' (uploads, seed)
  source_name     text NOT NULL,
  publisher       text NOT NULL,
  terms_url       text,
  contract_ref    text,                         -- DATA-01: signed agreement reference; NULL for every v1 public source
  licence_kind    text NOT NULL CHECK (licence_kind IN ('public_domain','open_data','exchange_delayed','unofficial','cc_by_sa','vendor_terms','internal')),
  display         boolean NOT NULL DEFAULT true,
  non_display     boolean NOT NULL DEFAULT false,   -- DATA-01 distinction: programmatic / non-display use
  derived         boolean NOT NULL DEFAULT true,
  redistribution  boolean NOT NULL DEFAULT false,
  export_allowed  boolean NOT NULL DEFAULT true,
  api_allowed     boolean NOT NULL DEFAULT true,
  max_tier        tier NOT NULL DEFAULT 'delayed',  -- ceiling any grant can reach for this source (evaluator rule 3)
  intrinsic_delay_min int NOT NULL DEFAULT 15,
  retention_days  int,                              -- NULL = unlimited; the ONLY input to partition drops and retentionPurge (STOR-07)
  attribution     text NOT NULL,                    -- screen footers and CSV header line
  rate_limit      text NOT NULL,                    -- '25/min', '10/s' — documentation; buckets live in providers/http.ts
  requires_user_agent boolean NOT NULL DEFAULT false,
  api_key_env     text,                             -- 'OPENFIGI_API_KEY', 'FRED_API_KEY'
  audit_obligation text,
  notes           text,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint REFERENCES provenance(provenance_id),   -- NULL only for rows written by seed/licences.ts (bootstrap)
  CONSTRAINT licence_registry_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT licence_registry_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT licence_registry_bt_excl EXCLUDE USING gist (source_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX licence_registry_current_idx ON licence_registry (source_id) WHERE tx_to = 'infinity';
CREATE TRIGGER licence_registry_bt_guard BEFORE UPDATE ON licence_registry FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

-- source_id is the logical key of the registry (versioned), so tables cannot carry a plain FK to it;
-- validity is enforced by this generic trigger (a source must exist in the registry before anything cites it).
CREATE FUNCTION assert_source_known() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM licence_registry l WHERE l.source_id = NEW.source_id AND l.tx_to = 'infinity') THEN
    RAISE EXCEPTION 'unknown source_id % (register it in providers/licences.ts first)', NEW.source_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provenance_source_known BEFORE INSERT ON provenance FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE field_licence (                    -- every field × asset class → the source that supplies it (evaluator rule 1)
  field_id     text NOT NULL,                   -- from core/fields/dictionary.ts ('PX_LAST', 'REVENUE', 'RATE_P25' …)
  asset_class  asset_class NOT NULL,
  source_id    text NOT NULL,
  field_class  field_class NOT NULL,
  PRIMARY KEY (field_id, asset_class)
);
CREATE INDEX field_licence_source_idx ON field_licence (source_id);
CREATE TRIGGER field_licence_source_known BEFORE INSERT OR UPDATE ON field_licence FOR EACH ROW EXECUTE FUNCTION assert_source_known();
```

Rules: every value-bearing row cites a `provenance_id`; `provenance` is append-only (WORM trigger in
§15) because it is the audit trail behind every number; `GET /api/v1/admin/trace/:traceId` joins
`provenance.trace_id`. The registry is seeded by `packages/server/src/seed/licences.ts` from
`packages/server/src/providers/licences.ts` (one row per `source_id` above, `display=true,
redistribution=false, max_tier='delayed'` for Cboe/Yahoo/CoinGecko and `'eod'` for daily sources;
`retention_days` = 400 for `yahoo.chart` intraday, 30 for `cboe.quotes` ticks, 10 for `cboe.options`
chain snapshots, NULL otherwise). Startup validates every `field_licence.field_id` against the
dictionary (ARCHITECTURE §12.1 step 3). Any change to `licence_registry` or `field_licence` bumps
`config_versions('entitlements')` (§14) so the in-memory evaluator cache reloads.

---

## 3. Migration 0003 — security master and identifier cross-reference (REF-01, REF-02, REF-03)

Issuer → issue → instrument → listing → market-data line, exactly as `packages/core/src/types/instrument.ts`
(ARCHITECTURE §4.1). Column names are the snake_case of the TypeScript fields.

```sql
-- migration: 0003_security_master.sql
CREATE SEQUENCE issuer_id_seq;  CREATE SEQUENCE issue_id_seq;   CREATE SEQUENCE instrument_id_seq;
CREATE SEQUENCE listing_id_seq; CREATE SEQUENCE md_line_id_seq; CREATE SEQUENCE ca_id_seq; CREATE SEQUENCE person_id_seq;

CREATE TABLE issuers (                          -- legal entity: Apple Inc., US Treasury, SPDR Trust, an index provider, a central bank
  version_id      bigserial PRIMARY KEY,
  issuer_id       bigint NOT NULL DEFAULT nextval('issuer_id_seq'),
  name            text   NOT NULL,
  legal_name      text,
  lei             char(20),
  cik             char(10),                     -- zero-padded '0000320193'
  country         char(2),
  state_of_inc    text,
  sic             char(4),                      -- SEC submissions.sic '3571'
  sic_description text,
  entity_type     text NOT NULL DEFAULT 'operating' CHECK (entity_type IN ('operating','fund','sovereign','index_provider','central_bank','other')),
  fiscal_year_end char(4),                      -- 'MMDD' from SEC submissions.fiscalYearEnd ('0926')
  filer_category  text,                         -- 'Large accelerated filer'
  website         text,
  former_names    jsonb NOT NULL DEFAULT '[]',  -- [{name, from, to}] from SEC submissions.formerNames
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT issuers_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT issuers_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT issuers_bt_excl EXCLUDE USING gist (issuer_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX issuers_current_idx ON issuers (issuer_id) WHERE tx_to = 'infinity';
CREATE INDEX issuers_lei_idx     ON issuers (lei)       WHERE tx_to = 'infinity' AND lei IS NOT NULL;
CREATE INDEX issuers_cik_idx     ON issuers (cik)       WHERE tx_to = 'infinity' AND cik IS NOT NULL;
CREATE INDEX issuers_name_trgm   ON issuers USING gin (name gin_trgm_ops) WHERE tx_to = 'infinity';
CREATE TRIGGER issuers_bt_guard BEFORE UPDATE ON issuers FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE issues (                           -- a share class / bond / fund share / index definition / fx pair / rate / series
  version_id        bigserial PRIMARY KEY,
  issue_id          bigint      NOT NULL DEFAULT nextval('issue_id_seq'),
  issuer_id         bigint      NOT NULL,
  asset_class       asset_class NOT NULL,
  security_type     text        NOT NULL,       -- OpenFIGI securityType: 'Common Stock','ETP','REIT','Index','Spot','US GOVERNMENT','Equity Option'
  security_type2    text,
  share_class_figi  char(12),
  isin              char(12),
  cusip             char(9),
  sedol             char(7),
  name              text        NOT NULL,
  currency          char(3)     NOT NULL,
  country_of_issue  char(2),
  par_value         numeric(18,6),
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT issues_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT issues_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT issues_bt_excl EXCLUDE USING gist (issue_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX issues_current_idx ON issues (issue_id)  WHERE tx_to = 'infinity';
CREATE INDEX issues_issuer_idx  ON issues (issuer_id) WHERE tx_to = 'infinity';
CREATE INDEX issues_isin_idx    ON issues (isin)      WHERE tx_to = 'infinity' AND isin IS NOT NULL;
CREATE INDEX issues_cusip_idx   ON issues (cusip)     WHERE tx_to = 'infinity' AND cusip IS NOT NULL;
CREATE TRIGGER issues_bt_guard BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE instruments (                      -- the thing a user names on the command line (composite level): 'AAPL US'
  version_id          bigserial PRIMARY KEY,
  instrument_id       bigint        NOT NULL DEFAULT nextval('instrument_id_seq'),
  issue_id            bigint        NOT NULL,
  asset_class         asset_class   NOT NULL,
  market_sector       market_sector NOT NULL,
  composite_figi      char(12),
  ticker              text          NOT NULL,   -- 'AAPL', 'SPX', 'EURUSD', '912797VE4', 'AAPL260916C00245000', 'SOFR', 'CPIAUCSL'
  exch_code           text          NOT NULL,   -- OpenFIGI composite code 'US'; 'GOVT','FX','INDEX','RATE','ECON','CRYPTO' for non-listed
  name                text          NOT NULL,
  currency            char(3)       NOT NULL,
  primary_listing_id  bigint,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','delisted','pending','matured','expired')),
  search_weight       real NOT NULL DEFAULT 1.0, -- autocomplete prior (index members > 1; Cboe-only symbols < 1)
  price_decimals      smallint NOT NULL DEFAULT 2, -- display hint (Yahoo priceHint); the formatter in core decides
  first_trade_date    date,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT instruments_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT instruments_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT instruments_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX instruments_current_idx ON instruments (instrument_id) WHERE tx_to = 'infinity';
CREATE INDEX instruments_ticker_idx  ON instruments (upper(ticker), exch_code, market_sector) WHERE tx_to = 'infinity' AND valid_to = 'infinity';
CREATE INDEX instruments_figi_idx    ON instruments (composite_figi) WHERE tx_to = 'infinity' AND composite_figi IS NOT NULL;
CREATE INDEX instruments_name_trgm   ON instruments USING gin (name gin_trgm_ops) WHERE tx_to = 'infinity';
CREATE INDEX instruments_issue_idx   ON instruments (issue_id) WHERE tx_to = 'infinity';
CREATE INDEX instruments_class_idx   ON instruments (asset_class, status) WHERE tx_to = 'infinity' AND valid_to = 'infinity';
CREATE TRIGGER instruments_bt_guard BEFORE UPDATE ON instruments FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE listings (                         -- one instrument, many venues (OpenFIGI venue FIGIs UN/UW/UA/UP/…)
  version_id     bigserial PRIMARY KEY,
  listing_id     bigint NOT NULL DEFAULT nextval('listing_id_seq'),
  instrument_id  bigint NOT NULL,
  figi           char(12),
  mic            char(4),                       -- exchanges.mic 'XNAS','XNYS','ARCX','BATS','XCBO' (FK by convention: exchanges is created in 0005)
  exch_code      text NOT NULL,                 -- OpenFIGI venue code 'UW'
  local_ticker   text NOT NULL,
  is_primary     boolean NOT NULL DEFAULT false,
  listing_status text NOT NULL DEFAULT 'active' CHECK (listing_status IN ('active','suspended','delisted')),
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT listings_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT listings_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT listings_bt_excl EXCLUDE USING gist (listing_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX listings_current_idx    ON listings (listing_id)    WHERE tx_to = 'infinity';
CREATE INDEX listings_instrument_idx ON listings (instrument_id) WHERE tx_to = 'infinity';
CREATE INDEX listings_figi_idx       ON listings (figi)          WHERE tx_to = 'infinity' AND figi IS NOT NULL;
CREATE TRIGGER listings_bt_guard BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE md_lines (                         -- market-data line = (instrument | listing) × (source, provider symbol)
  version_id            bigserial PRIMARY KEY,
  md_line_id            bigint NOT NULL DEFAULT nextval('md_line_id_seq'),
  instrument_id         bigint NOT NULL,
  listing_id            bigint,                 -- NULL = composite line
  source_id             text   NOT NULL,        -- licence_registry.source_id (trigger-checked)
  provider_symbol       text   NOT NULL,        -- cboe 'AAPL' | '_SPX'; yahoo 'AAPL' | '^GSPC' | 'EURUSD=X'; coingecko 'bitcoin'; nyfed 'SOFR'
  line_kind             text   NOT NULL CHECK (line_kind IN ('composite','venue','derived','reference')),
  intrinsic_delay_min   int    NOT NULL,        -- cboe 15, yahoo 15, nyfed 0
  expected_interval_ms  int    NOT NULL,        -- poll cadence during session; drives staleness (10000 for cboe.quotes)
  priority              smallint NOT NULL DEFAULT 100,  -- lower wins ties in composite merge (cboe 10, yahoo 20)
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT md_lines_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT md_lines_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT md_lines_bt_excl EXCLUDE USING gist (md_line_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity'),
  -- a provider symbol feeds at most one line at a time
  CONSTRAINT md_lines_symbol_excl EXCLUDE USING gist (source_id WITH =, provider_symbol WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX md_lines_current_idx    ON md_lines (md_line_id)    WHERE tx_to = 'infinity';
CREATE INDEX md_lines_instrument_idx ON md_lines (instrument_id) WHERE tx_to = 'infinity';
CREATE INDEX md_lines_symbol_idx     ON md_lines (source_id, provider_symbol) WHERE tx_to = 'infinity';
CREATE TRIGGER md_lines_bt_guard BEFORE UPDATE ON md_lines FOR EACH ROW EXECUTE FUNCTION bt_guard_update();
CREATE TRIGGER md_lines_source_known BEFORE INSERT ON md_lines FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE identifiers (                      -- REF-01 cross-reference; a ticker is reused across time, never across a valid range
  version_id   bigserial PRIMARY KEY,
  entity_kind  entity_kind NOT NULL,
  entity_id    bigint      NOT NULL,
  scheme       id_scheme   NOT NULL,
  value        text        NOT NULL,            -- 'BBG000B9XRY4','US0378331005','037833100','2046251','0000320193','HWUPKR0MPOU8FGXBT394','XNAS','AAPL'
  qualifier    text        NOT NULL DEFAULT '', -- TICKER_EXCH: exch code ('US','UW'); PROVIDER_SYMBOL / SERIES_CODE: source_id; RIC: '' ; MIC: ''
  is_primary   boolean     NOT NULL DEFAULT false,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT identifiers_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT identifiers_tx_range    CHECK (tx_from < tx_to),
  -- an identifier value maps to at most one entity at any valid instant (as currently believed)
  CONSTRAINT identifiers_bt_excl EXCLUDE USING gist (scheme WITH =, value WITH =, qualifier WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX identifiers_lookup_idx ON identifiers (scheme, value) WHERE tx_to = 'infinity';
CREATE INDEX identifiers_entity_idx ON identifiers (entity_kind, entity_id) WHERE tx_to = 'infinity';
CREATE INDEX identifiers_value_trgm ON identifiers USING gin (value gin_trgm_ops) WHERE tx_to = 'infinity';
CREATE TRIGGER identifiers_bt_guard BEFORE UPDATE ON identifiers FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

-- Convenience views (as of now/now) for non-PIT screens (DES, Q, autocomplete snapshot). Backtest-facing repos never use these.
CREATE VIEW issuers_now     AS SELECT * FROM issuers     WHERE bt_as_of(valid_from, valid_to, tx_from, tx_to, now(), now());
CREATE VIEW issues_now      AS SELECT * FROM issues      WHERE bt_as_of(valid_from, valid_to, tx_from, tx_to, now(), now());
CREATE VIEW instruments_now AS SELECT * FROM instruments WHERE bt_as_of(valid_from, valid_to, tx_from, tx_to, now(), now());
CREATE VIEW listings_now    AS SELECT * FROM listings    WHERE bt_as_of(valid_from, valid_to, tx_from, tx_to, now(), now());
CREATE VIEW md_lines_now    AS SELECT * FROM md_lines    WHERE bt_as_of(valid_from, valid_to, tx_from, tx_to, now(), now());
CREATE VIEW identifiers_now AS SELECT * FROM identifiers WHERE bt_as_of(valid_from, valid_to, tx_from, tx_to, now(), now());
```

### 3.1 Mapping rules from the recorded fixtures

| Fixture | Rows produced |
| --- | --- |
| `openfigi-map` (275 venue rows for AAPL, all `compositeFIGI=BBG000B9XRY4`, `shareClassFIGI=BBG001S5N8V8`) | one `issues` row per `shareClassFIGI` (`security_type='Common Stock'`); one `instruments` row per composite `exchCode` (`US`) with `ticker='AAPL'`, `composite_figi`; one `listings` row per venue FIGI (`UN`,`UW`,`UA`,`UP`…) with `mic` from `exchanges.bbg_exch_code`; identifiers `COMPOSITE_FIGI`, `SHARE_CLASS_FIGI`, `FIGI` (per listing), `TICKER_EXCH` (`AAPL`/`US`, `AAPL`/`UW` …). Non-US composites (`GR`,`LN`) become further instruments under the same issue. |
| `sec-company-tickers.json` (10,422 `{cik_str, ticker, title}`) | `issuers` (with `cik`) + `identifiers CIK`; ticker joins the Cboe symbol book to attach `issuer_id` to `issues`. |
| `sec-submissions-*.json` | `issuers.sic/sic_description/fiscal_year_end/state_of_inc/filer_category/former_names`; `identifiers LEI` when non-null. |
| `cboe-symbol-book.json` (35,618 `{name, company_name}`) | `instruments` (`asset_class` `equity`/`etf` by suffix and SEC join; symbols matching Cboe futures/index roots such as `A2RZ1` are `future` with `status='pending'` and `search_weight=0.1`) + `md_lines (cboe.quotes, name)`; `identifiers PROVIDER_SYMBOL` qualifier `cboe.quotes`. |
| `sec-nport-SPY-primary_doc.xml` (504 `invstOrSec` with `cusip`, `isin`, `lei`) | `issues.cusip/isin`, `identifiers CUSIP/ISIN/LEI` for S&P 500 names; resolution is CUSIP first, then ISIN, then name alias. |
| `treasury-bills.xml` (`CUSIP_4WK=912797VE4` … `CUSIP_52WK`) | issuer `US Treasury` (`entity_type='sovereign'`), one `issues`+`instruments` per CUSIP (`asset_class='govt'`, `exch_code='GOVT'`, `ticker=CUSIP`), `md_lines (treasury.bills, '4WK')`, `identifiers CUSIP`. |
| `cboe-options` (3,510 contracts `AAPL260916C00245000`) | one `instruments` row per contract (`asset_class='option'`, `market_sector='Equity'`, `ticker=OCC`, `exch_code='US'`), `identifiers OCC`, `md_lines (cboe.options, occ)`. |
| Yahoo symbols (`^GSPC`, `^FTSE`, `EURUSD=X`, `^TNX`) | index/fx instruments with `exch_code='INDEX'`/`'FX'`, `md_lines (yahoo.chart, symbol)`; Cboe `_SPX`/`_VIX` as a second line (priority 10). |
| NY Fed types (`SOFR`,`EFFR`,`OBFR`,`TGCR`,`BGCR`,`SOFRAI`) | issuer `Federal Reserve Bank of New York` (`central_bank`), `asset_class='rate'`, `market_sector='Index'`, `exch_code='RATE'`, `md_lines (nyfed.rates, type)`. |
| Econ series (`CPIAUCSL`, `DGS10`, `CUUR0000SA0`) | `asset_class='econ'`, `exch_code='ECON'`, `identifiers SERIES_CODE` qualifier = source; observations live in `econ_observations` (§9). |

---

## 4. Migration 0004 — terms & conditions (REF-04, REF-05)

```sql
-- migration: 0004_terms.sql
CREATE TABLE govt_terms (                       -- US Treasury bills/notes/bonds/TIPS/FRNs; columns cover REF-04 in full
  version_id          bigserial PRIMARY KEY,
  instrument_id       bigint  NOT NULL,
  security_type       text    NOT NULL CHECK (security_type IN ('bill','note','bond','tips','frn')),
  cusip               char(9) NOT NULL,
  term_label          text,                             -- '4WK','13WK','2Y','10Y','30Y'
  issue_date          date,
  dated_date          date,
  maturity_date       date    NOT NULL,
  coupon_type         text    NOT NULL DEFAULT 'fixed' CHECK (coupon_type IN ('fixed','zero','float','step','inflation_linked')),
  coupon_rate         numeric(9,6),                     -- percent; NULL for bills
  coupon_freq         smallint NOT NULL DEFAULT 2,
  day_count           text    NOT NULL CHECK (day_count IN ('ACT/ACT','ACT/360','ACT/365F','30/360','30E/360','ACT/ACT-ISDA')),  -- notes/bonds ACT/ACT, bills ACT/360
  first_coupon_date   date,
  last_regular_coupon date,
  business_day_conv   text    NOT NULL DEFAULT 'following' CHECK (business_day_conv IN ('following','modified_following','preceding','none')),
  calendar_id         text    NOT NULL DEFAULT 'SIFMA',
  settlement_days     smallint NOT NULL DEFAULT 1,
  reference_index     text,                             -- 'SOFR' for FRNs
  spread_bp           numeric(9,4),
  index_ratio_base    numeric(14,8),                    -- TIPS
  is_callable         boolean NOT NULL DEFAULT false,
  call_schedule       jsonb   NOT NULL DEFAULT '[]',    -- [{date, price, kind:'call'|'make_whole', spread_bp}] (empty for modern Treasuries; kept for REF-04 shape)
  put_schedule        jsonb   NOT NULL DEFAULT '[]',    -- [{date, price}]
  sink_schedule       jsonb   NOT NULL DEFAULT '[]',    -- [{date, amount_pct}]
  amortisation        jsonb   NOT NULL DEFAULT '[]',    -- [{date, factor}]
  make_whole          jsonb,                            -- {benchmark, spread_bp}
  covenants           text,
  guarantors          text[]  NOT NULL DEFAULT '{}',
  seniority           text    NOT NULL DEFAULT 'sovereign',
  collateral          text,
  min_denomination    numeric(14,2) NOT NULL DEFAULT 100,
  increment           numeric(14,2) NOT NULL DEFAULT 100,
  amount_outstanding  numeric(28,2),
  on_the_run          boolean NOT NULL DEFAULT false,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT govt_terms_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT govt_terms_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT govt_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX govt_terms_current_idx  ON govt_terms (instrument_id) WHERE tx_to = 'infinity';
CREATE INDEX govt_terms_maturity_idx ON govt_terms (maturity_date) WHERE tx_to = 'infinity';       -- SRCH by maturity
CREATE INDEX govt_terms_cusip_idx    ON govt_terms (cusip)         WHERE tx_to = 'infinity';
CREATE TRIGGER govt_terms_bt_guard BEFORE UPDATE ON govt_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE option_terms (                     -- listed US equity options (Cboe chain) (REF-05)
  version_id               bigserial PRIMARY KEY,
  instrument_id            bigint NOT NULL,
  occ_symbol               varchar(21) NOT NULL,       -- 'AAPL260916C00245000' as Cboe publishes it (root unpadded); OSI form derived by core/ids/occ.ts
  root                     text NOT NULL,
  underlying_instrument_id bigint NOT NULL,
  expiry                   date NOT NULL,
  strike                   numeric(14,4) NOT NULL,
  put_call                 char(1) NOT NULL CHECK (put_call IN ('C','P')),
  exercise_style           text NOT NULL DEFAULT 'american' CHECK (exercise_style IN ('american','european')),
  settlement               text NOT NULL DEFAULT 'physical' CHECK (settlement IN ('physical','cash')),
  am_pm_settlement         char(2) NOT NULL DEFAULT 'pm' CHECK (am_pm_settlement IN ('am','pm')),
  multiplier               int  NOT NULL DEFAULT 100,
  tick_size                numeric(8,4),
  exercise_cutoff_local    time NOT NULL DEFAULT '17:30',
  is_weekly                boolean NOT NULL DEFAULT false,
  last_trade_date          date,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT option_terms_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT option_terms_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT option_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX option_terms_current_idx ON option_terms (instrument_id) WHERE tx_to = 'infinity';
CREATE INDEX option_terms_chain_idx   ON option_terms (underlying_instrument_id, expiry, strike, put_call) WHERE tx_to = 'infinity';  -- OMON
CREATE INDEX option_terms_occ_idx     ON option_terms (occ_symbol) WHERE tx_to = 'infinity';
CREATE TRIGGER option_terms_bt_guard BEFORE UPDATE ON option_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE future_terms (                     -- shape only in v1 (no futures source) (REF-05)
  version_id               bigserial PRIMARY KEY,
  instrument_id            bigint NOT NULL,
  root                     text NOT NULL,
  underlying_instrument_id bigint,
  exchange_mic             char(4),
  expiry                   date NOT NULL,
  last_trade_date          date,
  first_notice_date        date,
  first_delivery_date      date,
  multiplier               numeric(14,4) NOT NULL,
  tick_size                numeric(10,6) NOT NULL,
  tick_value               numeric(14,6),
  settlement               text NOT NULL CHECK (settlement IN ('physical','cash')),
  delivery_months          text[] NOT NULL DEFAULT '{}',
  roll_convention          jsonb,                       -- {rule:'days_before_expiry', days:5}
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT future_terms_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT future_terms_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT future_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX future_terms_current_idx ON future_terms (instrument_id) WHERE tx_to = 'infinity';
CREATE TRIGGER future_terms_bt_guard BEFORE UPDATE ON future_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE fund_terms (                       -- ETFs (SPY: N-PORT filer CIK 0000884394)
  version_id                  bigserial PRIMARY KEY,
  instrument_id               bigint NOT NULL,
  fund_type                   text NOT NULL DEFAULT 'etf' CHECK (fund_type IN ('etf','etn','mutual_fund','closed_end')),
  tracked_index_instrument_id bigint,
  sponsor                     text,
  cik                         char(10),
  series_id                   text,
  expense_ratio               numeric(8,6),
  inception_date              date,
  distribution_freq           text,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT fund_terms_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT fund_terms_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT fund_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX fund_terms_current_idx ON fund_terms (instrument_id) WHERE tx_to = 'infinity';
CREATE TRIGGER fund_terms_bt_guard BEFORE UPDATE ON fund_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE index_terms (
  version_id               bigserial PRIMARY KEY,
  instrument_id            bigint NOT NULL,
  provider                 text NOT NULL,               -- 'S&P Dow Jones','Cboe','FTSE Russell','Nikkei','STOXX'
  methodology              text NOT NULL CHECK (methodology IN ('cap_weighted','float_cap_weighted','price_weighted','equal_weighted','volatility','other')),
  calc_currency            char(3) NOT NULL,
  region                   text,
  base_date                date,
  base_value               numeric(14,4),
  constituent_count        int,
  proxy_fund_instrument_id bigint,                      -- SPY for SPX (membership + intraday proxy)
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT index_terms_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT index_terms_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT index_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX index_terms_current_idx ON index_terms (instrument_id) WHERE tx_to = 'infinity';
CREATE TRIGGER index_terms_bt_guard BEFORE UPDATE ON index_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE fx_terms (
  version_id       bigserial PRIMARY KEY,
  instrument_id    bigint NOT NULL,
  base_ccy         char(3) NOT NULL,
  quote_ccy        char(3) NOT NULL,
  spot_lag         smallint NOT NULL DEFAULT 2,         -- T+2 (USDCAD T+1)
  calendar_id      text NOT NULL DEFAULT 'FX_USD',
  pip_size         numeric(10,8) NOT NULL DEFAULT 0.0001,
  quote_convention text NOT NULL DEFAULT 'quote_per_base' CHECK (quote_convention IN ('quote_per_base','base_per_quote')),
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT fx_terms_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT fx_terms_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT fx_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX fx_terms_current_idx ON fx_terms (instrument_id) WHERE tx_to = 'infinity';
CREATE TRIGGER fx_terms_bt_guard BEFORE UPDATE ON fx_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE rate_terms (                       -- SOFR, EFFR, OBFR, TGCR, BGCR, SOFRAI (SOFR averages/index)
  version_id          bigserial PRIMARY KEY,
  instrument_id       bigint NOT NULL,
  rate_code           text NOT NULL,                    -- NY Fed `type`
  publisher           text NOT NULL,                    -- 'NY Fed'
  day_count           text NOT NULL DEFAULT 'ACT/360',
  publication_time_et time,                             -- 08:00 for SOFR
  tenor_days          int  NOT NULL DEFAULT 1,
  compounding         text NOT NULL DEFAULT 'simple' CHECK (compounding IN ('simple','compounded','index')),
  series_id           bigint,                           -- econ_series.series_id holding the headline observations (§9)
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT rate_terms_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT rate_terms_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT rate_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX rate_terms_current_idx ON rate_terms (instrument_id) WHERE tx_to = 'infinity';
CREATE TRIGGER rate_terms_bt_guard BEFORE UPDATE ON rate_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();
```

`refdata/terms.ts` exposes `govtTerms(instrumentId, asOf)`, `optionTerms(instrumentId, asOf)`,
`optionChain(underlyingId, asOf, { expiry? })`, `futureTerms`, `fundTerms`, `indexTerms`, `fxTerms`,
`rateTerms`; every function takes `AsOf` (no default) so YAS, OVML and SRCH price with the terms
believed at `knownAt` (REF-03, ANAL-08).

---

## 5. Migration 0005 — exchanges, calendars, classifications, index membership, entities (REF-06, REF-07, REF-08)

```sql
-- migration: 0005_calendars_classifications.sql
CREATE TABLE calendars (                        -- REF-06: exchange, settlement, currency and government calendars
  calendar_id text PRIMARY KEY,                 -- 'XNYS','XNAS','XCBO','SIFMA','USGOVT','FX_USD','TARGET2','XLON','WEEKEND'
  name        text NOT NULL,
  tz          text NOT NULL,                    -- 'America/New_York'
  kind        text NOT NULL CHECK (kind IN ('exchange','settlement','currency','government','weekend')),
  source_id   text NOT NULL                     -- 'internal.derived' (rule-generated in core/calendars) — trigger-checked
);
CREATE TRIGGER calendars_source_known BEFORE INSERT OR UPDATE ON calendars FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE calendar_sessions (                -- regular weekly session template (FEED-06 session lifecycle inputs)
  calendar_id text NOT NULL REFERENCES calendars(calendar_id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  pre_open    time,                             -- 04:00 NYSE/Nasdaq pre-market
  open_time   time NOT NULL,                    -- 09:30
  close_time  time NOT NULL,                    -- 16:00
  post_close  time,                             -- 20:00
  PRIMARY KEY (calendar_id, weekday)
);

CREATE TABLE calendar_holidays (                -- rule-generated 1990–2040 by core/calendars at seed; ad-hoc closures added by data ops
  calendar_id text NOT NULL REFERENCES calendars(calendar_id),
  day         date NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('closed','early_close')),
  close_time  time,                             -- 13:00 on NYSE early closes; 14:00 SIFMA
  PRIMARY KEY (calendar_id, day)
);

CREATE TABLE exchanges (
  mic              char(4) PRIMARY KEY,         -- 'XNAS','XNYS','ARCX','BATS','XCBO','XLON','XETR','XTKS'
  operating_mic    char(4) NOT NULL,
  name             text NOT NULL,
  country          char(2) NOT NULL,
  tz               text NOT NULL,
  calendar_id      text NOT NULL REFERENCES calendars(calendar_id),
  bbg_exch_code    text,                        -- OpenFIGI venue code: 'UW'→XNAS, 'UN'→XNYS, 'UP'→ARCX, 'UF'→BATS, 'LN'→XLON
  composite_code   text,                        -- 'US' for every US venue
  cboe_exchange_id int                          -- Cboe `exchange_id` (2 = Nasdaq-listed stock, 5 = Cboe index, 115 = Cboe Europe)
);
CREATE UNIQUE INDEX exchanges_bbg_code_idx ON exchanges (bbg_exch_code) WHERE bbg_exch_code IS NOT NULL;

CREATE TABLE classification_schemes (           -- REF-07 schemes
  scheme    text PRIMARY KEY,                   -- 'GICS','SIC','NAICS','ICB','INTERNAL','NPORT_ASSETCAT'
  name      text NOT NULL,
  source_id text NOT NULL,                      -- 'wiki.sp500' (GICS names, cc_by_sa), 'sec.submissions' (SIC), 'internal.derived'
  levels    smallint NOT NULL
);
CREATE TRIGGER classification_schemes_source_known BEFORE INSERT OR UPDATE ON classification_schemes FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE classification_codes (
  scheme      text NOT NULL REFERENCES classification_schemes(scheme),
  code        text NOT NULL,                    -- GICS '45' sector, '4520' industry group, '452020' industry, '45202030' sub-industry; SIC '3571'
  name        text NOT NULL,
  parent_code text,
  level       smallint NOT NULL,
  PRIMARY KEY (scheme, code)
);

CREATE TABLE entity_classifications (           -- bitemporal: sector changes have effective dates
  version_id  bigserial PRIMARY KEY,
  entity_kind entity_kind NOT NULL CHECK (entity_kind IN ('issuer','instrument')),
  entity_id   bigint NOT NULL,
  scheme      text NOT NULL,
  code        text NOT NULL,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT entity_classifications_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT entity_classifications_tx_range    CHECK (tx_from < tx_to),
  FOREIGN KEY (scheme, code) REFERENCES classification_codes(scheme, code),
  CONSTRAINT entity_classifications_bt_excl EXCLUDE USING gist (entity_kind WITH =, entity_id WITH =, scheme WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX entity_classifications_current_idx ON entity_classifications (entity_kind, entity_id, scheme) WHERE tx_to = 'infinity';
CREATE INDEX entity_classifications_lookup_idx  ON entity_classifications (scheme, code) WHERE tx_to = 'infinity';   -- EQS / RV peer sets
CREATE TRIGGER entity_classifications_bt_guard BEFORE UPDATE ON entity_classifications FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE indices (                          -- one row per index whose membership we track
  index_id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                     text NOT NULL UNIQUE,        -- 'SPX','NDX','RTY','INDU','VIX','UKX','DAX','CAC','SX5E','NKY','HSI','AS51','BUK100P' …
  instrument_id            bigint NOT NULL UNIQUE,      -- the 'SPX Index' instrument
  proxy_fund_instrument_id bigint,                      -- SPY (N-PORT filer) — membership source for SPX
  membership_source_id     text,                        -- 'sec.archives' (N-PORT), 'ssga.holdings'; NULL = no membership source (WEI-only indices)
  provider                 text NOT NULL
);

CREATE TABLE index_members (                    -- REF-07 membership + weights with history; key (index_id, instrument_id)
  version_id    bigserial PRIMARY KEY,
  index_id      bigint NOT NULL REFERENCES indices(index_id),
  instrument_id bigint NOT NULL,
  weight        numeric(12,10),                          -- fraction: N-PORT pctVal / 100 (0.00083321585405), SSGA Weight / 100
  shares        numeric(20,4),                           -- N-PORT balance
  market_value  numeric(20,2),                           -- N-PORT valUSD
  as_of_date    date NOT NULL,                           -- N-PORT repPdDate (2026-06-30) or SSGA file date; = valid_from::date
  source_id     text NOT NULL,                           -- 'sec.archives' | 'ssga.holdings'
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT index_members_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT index_members_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT index_members_bt_excl EXCLUDE USING gist (index_id WITH =, instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX index_members_current_idx ON index_members (index_id, instrument_id) WHERE tx_to = 'infinity';
CREATE INDEX index_members_asof_idx    ON index_members (index_id, valid_from, valid_to) WHERE tx_to = 'infinity';   -- MEMB as-of
CREATE INDEX index_members_inst_idx    ON index_members (instrument_id) WHERE tx_to = 'infinity';                    -- "which indices hold X"
CREATE TRIGGER index_members_bt_guard BEFORE UPDATE ON index_members FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE people (                           -- REF-08 minimal: officers from SEC 8-K item 5.02, news authors, directory users (autocomplete 'person')
  version_id bigserial PRIMARY KEY,
  person_id  bigint NOT NULL DEFAULT nextval('person_id_seq'),
  name       text NOT NULL,
  role       text,                              -- 'CEO','CFO','Fed Chair','Reporter'
  issuer_id  bigint,
  user_id    bigint,                            -- when the person is a platform user (users.user_id; FK by convention, users created in 0011)
  aliases    text[] NOT NULL DEFAULT '{}',
  source_id  text NOT NULL,                     -- 'sec.atom' | 'bbg.rss' | 'internal.user'
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT people_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT people_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT people_bt_excl EXCLUDE USING gist (person_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX people_current_idx ON people (person_id) WHERE tx_to = 'infinity';
CREATE INDEX people_name_trgm   ON people USING gin (name gin_trgm_ops) WHERE tx_to = 'infinity';
CREATE TRIGGER people_bt_guard BEFORE UPDATE ON people FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE entity_relations (                 -- REF-08 hierarchy/ownership shape (v1 populated from N-PORT: fund holds issuer; ETF tracks index)
  version_id bigserial PRIMARY KEY,
  from_kind  entity_kind NOT NULL,
  from_id    bigint NOT NULL,
  to_kind    entity_kind NOT NULL,
  to_id      bigint NOT NULL,
  relation   text NOT NULL CHECK (relation IN ('parent_of','subsidiary_of','holds','officer_of','director_of','tracks','supplier_of','customer_of')),
  weight     numeric(12,10),
  source_id  text NOT NULL,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT entity_relations_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT entity_relations_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT entity_relations_bt_excl EXCLUDE USING gist (from_kind WITH =, from_id WITH =, to_kind WITH =, to_id WITH =, relation WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX entity_relations_from_idx ON entity_relations (from_kind, from_id) WHERE tx_to = 'infinity';
CREATE INDEX entity_relations_to_idx   ON entity_relations (to_kind, to_id)     WHERE tx_to = 'infinity';
CREATE TRIGGER entity_relations_bt_guard BEFORE UPDATE ON entity_relations FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE issuer_aliases (                   -- name matching for NEWS-02: 'Apple' → issuer; from SEC formerNames + curated
  issuer_id bigint NOT NULL,
  alias     text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('former_name','short_name','brand','curated')),
  PRIMARY KEY (issuer_id, alias)
);
CREATE INDEX issuer_aliases_trgm ON issuer_aliases USING gin (alias gin_trgm_ops);
CREATE INDEX issuer_aliases_lower_idx ON issuer_aliases (lower(alias));
```

Membership history semantics (REF-07): each weights snapshot (monthly N-PORT, daily SSGA) writes
versions with `valid_from = as_of_date` through `upsertVersion` (no row when the weight is unchanged);
a constituent absent from a snapshot has its current version narrowed to `valid_to = as_of_date`.
"Members of SPX on 2024-03-15 as known on 2024-04-01" is
`WHERE index_id = $1 AND bt_as_of(valid_from, valid_to, tx_from, tx_to, '2024-03-15', '2024-04-01')`.
Calendars are loaded into `core` `Calendar` objects at startup by `refdata/calendars.ts`; `combine()`
(union of holidays) is how every analytic builds FX/settlement calendars (REF-06).

---

## 6. Migration 0006 — corporate actions and adjustment-on-read (DATA-08, REF-09)

```sql
-- migration: 0006_corporate_actions.sql
CREATE TABLE corporate_actions (
  version_id        bigserial PRIMARY KEY,
  ca_id             bigint    NOT NULL DEFAULT nextval('ca_id_seq'),
  instrument_id     bigint    NOT NULL,
  ca_type           ca_type   NOT NULL,
  status            ca_status NOT NULL,                 -- estimated → announced → confirmed → paid | cancelled (DATA-08 pre-announcement vs confirmed)
  declared_date     date,
  ex_date           date      NOT NULL,
  record_date       date,
  pay_date          date,
  effective_date    date,
  amount            numeric(18,8),                      -- cash per share (dividends, capital return, tender price)
  currency          char(3),
  ratio_new         numeric(18,8),                      -- split 4:1 → new=4, old=1; reverse 1:10 → new=1, old=10; stock dividend 5 % → new=105, old=100
  ratio_old         numeric(18,8),
  new_instrument_id bigint,                             -- spinoff child / merger acquirer / new ticker's instrument
  frequency         text,                               -- 'quarterly','semiannual','annual','irregular'
  gross_or_net      text NOT NULL DEFAULT 'gross' CHECK (gross_or_net IN ('gross','net')),
  details           jsonb NOT NULL DEFAULT '{}',        -- merger terms, tender conditions, new ticker/name
  note              text,
  source_id         text NOT NULL,                      -- 'yahoo.chart' (events), 'sec.atom' (8-K), 'internal.user' (data ops)
  review_state      text NOT NULL DEFAULT 'auto' CHECK (review_state IN ('auto','queued','reviewed','rejected')),  -- REF-10 dual key
  reviewed_by       bigint,
  reviewed_at       timestamptz,
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT now(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT corporate_actions_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT corporate_actions_tx_range    CHECK (tx_from < tx_to),
  CONSTRAINT corporate_actions_ratio_chk   CHECK ((ratio_new IS NULL) = (ratio_old IS NULL)),
  CONSTRAINT corporate_actions_bt_excl EXCLUDE USING gist (ca_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity'),
  -- one action per (instrument, type, ex-date, source) at a time: an ingest re-run upserts instead of duplicating
  CONSTRAINT corporate_actions_natural_excl EXCLUDE USING gist (instrument_id WITH =, ca_type WITH =, ex_date WITH =, source_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX corporate_actions_current_idx ON corporate_actions (ca_id) WHERE tx_to = 'infinity';
CREATE INDEX corporate_actions_inst_ex_idx ON corporate_actions (instrument_id, ex_date) WHERE tx_to = 'infinity';
CREATE INDEX corporate_actions_ex_date_idx ON corporate_actions (ex_date) WHERE tx_to = 'infinity';                        -- CACS calendar
CREATE INDEX corporate_actions_review_idx  ON corporate_actions (review_state) WHERE tx_to = 'infinity' AND review_state = 'queued';
CREATE TRIGGER corporate_actions_bt_guard BEFORE UPDATE ON corporate_actions FOR EACH ROW EXECUTE FUNCTION bt_guard_update();
```

### 6.1 Adjustment policy (REF-09) — computed on read, one implementation: `packages/core/src/adjust/corporateActions.ts`

Stored bars are **always unadjusted** (ARCHITECTURE §4.3). `AdjustPolicy` lives in
`core/types/bars.ts` as `'unadjusted' | 'price' | 'total_return'`.

```ts
import type { AdjustPolicy, Bar } from '../types/bars';
export interface CaForAdjust { caType: CaType; status: CaStatus; exDate: string; amount?: number; ratioNew?: number; ratioOld?: number }
export interface FactorStep { beforeDate: string; priceFactor: number; volumeFactor: number; kind: 'split'|'dividend'|'capital_return' }
/**
 * Factors apply to bars with date < beforeDate (strictly before ex-date), cumulatively from latest to earliest.
 *  - split / reverse_split / stock_dividend / rights (policies 'price' and 'total_return'):
 *      priceFactor = ratioOld / ratioNew (4:1 → 0.25); volumeFactor = 1 / priceFactor.
 *  - cash_dividend / special_dividend / capital_return (policy 'total_return' only):
 *      priceFactor = 1 − amount / closeBeforeEx, where closeBeforeEx is the UNADJUSTED close of the last session
 *      before exDate (CRSP / Yahoo convention); volumeFactor = 1. `closes` supplies that close.
 *  - status 'cancelled' and 'estimated' are never applied ('estimated' is displayed on CACS only); 'announced',
 *    'confirmed' and 'paid' are applied.
 */
export function adjustmentFactors(actions: CaForAdjust[], closes: Array<{ date: string; close: number }>, policy: AdjustPolicy): FactorStep[];
export function applyAdjustment(bars: Bar[], steps: FactorStep[]): Bar[];   // O(n + k): prices × cumulative factor, volume × cumulative volumeFactor
/** TR_t = TR_{t−1} × (P_t + D_t) / P_{t−1}, base = first close; used by GP 'TR' overlay and PORT. */
export function totalReturnIndex(bars: Bar[], dividends: CaForAdjust[]): Array<{ date: string; value: number }>;
```

Read path (`packages/server/src/data/historical.ts#bars(req, asOf)`): load unadjusted `bars_daily`
for `[start − 1 session, end]`, load `corporate_actions` **as-of `asOf`** (so a backtest run "as known
on 2020-08-01" does not see the AAPL 4:1 split recorded 2020-07-31 unless `knownAt ≥ tx_from`), compute
steps, apply, return bars plus the steps in `meta.adjustments`. Golden values
(`fixtures/golden/analytics/adjust/aapl.json`): AAPL close 2020-08-28 = 499.23 unadjusted; policy
`price` → 124.8075 (4:1 on 2020-08-31); pre-2014-06-09 prices carry 1/28 (7:1 × 4:1): 645.57 → 23.0561.
Yahoo `adjclose` is stored on `bars_daily.src_adj_close` for reconciliation only and is never served.

---

## 7. Migration 0007 — bars, ticks, quote snapshots and the partitioning strategy (STOR-01, STOR-02, STOR-05, FEED-05, FEED-07)

### 7.1 Partitioning on plain Postgres 14

Declarative `RANGE` partitioning; no TimescaleDB. Rules that make it work on stock PG 14:

1. Every primary key **contains the partition column** (a PG requirement for unique constraints on partitioned tables).
2. Surrogate ids on partitioned tables come from an explicit `CREATE SEQUENCE`, never `GENERATED … AS IDENTITY` (unsupported on partitioned tables before PG 17).
3. Indexes are declared once on the parent and cascade to every partition (PG 11+).
4. Every partitioned table has a `<table>_default` partition so an out-of-window row never fails an insert; the `dqMonitors` job raises `dq_events kind='default_partition_nonempty'` when it is not empty, and `ensurePartitions` moves such rows into the new partition before attaching it (§16).
5. Retention (STOR-05, STOR-07): `partitionMaintenance.ts` drops partitions whose upper bound is older than `licence_registry.retention_days` of the table's governing source (`quote_ticks` → `cboe.quotes` 30 d, `option_quotes` → `cboe.options` 10 d, `bars_intraday` → `yahoo.chart` 400 d). Hot tier is the in-memory plant; warm tier is `quote_snapshots`/recent partitions; cold tier is older partitions (query transparency is automatic: one parent table).
6. Outbound foreign keys from partitioned tables (`provenance_id`) are legal since PG 11 and kept; no table has an inbound FK to a partitioned table.

| Table | Partition key | Granularity | Naming | Retention |
| --- | --- | --- | --- | --- |
| `bars_daily` | `session_date` | yearly (+ `bars_daily_pre2000`) | `bars_daily_y2026` | unlimited |
| `bars_intraday` | `bar_ts` | monthly | `bars_intraday_m2026_09` | 400 d (`yahoo.chart`) |
| `quote_ticks` | `capture_ts` | daily | `quote_ticks_d2026_09_15` | 30 d (`cboe.quotes`) |
| `option_quotes` | `capture_ts` | daily | `option_quotes_d2026_09_15` | 10 d (`cboe.options`) |
| `access_log` (§11) | `ts` | monthly | `access_log_m2026_09` | max(licence, 7 y) |
| `usage_events` (§14) | `ts` | monthly | `usage_events_m2026_09` | 730 d |

### 7.2 DDL

```sql
-- migration: 0007_market_data.sql
CREATE TABLE bars_daily (                       -- UNADJUSTED always (REF-09: adjust on read); one truth row per instrument-day
  instrument_id  bigint NOT NULL,
  session_date   date   NOT NULL,
  md_line_id     bigint NOT NULL,               -- which line supplied the bar (yahoo.chart, frankfurter, treasury.yieldcurve)
  open           numeric(18,6),
  high           numeric(18,6),
  low            numeric(18,6),
  close          numeric(18,6) NOT NULL,
  volume         bigint,
  vwap           numeric(18,6),
  trade_count    int,
  official_close numeric(18,6),                 -- exchange official close when the source states it (Cboe 'close' after session)
  src_adj_close  numeric(18,6),                 -- Yahoo adjclose, reconciliation only, never served
  source_ts      timestamptz,                   -- FEED-05 src
  capture_ts     timestamptz NOT NULL,          -- FEED-05 cap
  provenance_id  bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (instrument_id, session_date)
) PARTITION BY RANGE (session_date);
CREATE TABLE bars_daily_default PARTITION OF bars_daily DEFAULT;
CREATE INDEX bars_daily_date_idx ON bars_daily (session_date, instrument_id);   -- cross-section reads (EQS, WEI, reconcile)

CREATE TABLE bars_intraday (
  instrument_id bigint NOT NULL,
  bar_interval  text   NOT NULL CHECK (bar_interval IN ('1m','5m','1d')),   -- core/types/bars.ts BarInterval ('1d' only as a resample cache key)
  bar_ts        timestamptz NOT NULL,           -- bar start (UTC); Yahoo `timestamp[]` × 1000
  md_line_id    bigint NOT NULL,
  open          numeric(18,6),
  high          numeric(18,6),
  low           numeric(18,6),
  close         numeric(18,6) NOT NULL,
  volume        bigint,
  session       text NOT NULL DEFAULT 'regular' CHECK (session IN ('pre','regular','post')),
  is_final      boolean NOT NULL DEFAULT false, -- the last bar of a poll is provisional until the next poll passes it (b1m: IS_FINAL)
  capture_ts    timestamptz NOT NULL,
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (instrument_id, bar_interval, bar_ts)
) PARTITION BY RANGE (bar_ts);
CREATE TABLE bars_intraday_default PARTITION OF bars_intraday DEFAULT;

CREATE SEQUENCE quote_ticks_id_seq;
CREATE TABLE quote_ticks (                      -- STOR-01 analogue: one row per observed change of a provider line (a delayed "tick")
  tick_id       bigint NOT NULL DEFAULT nextval('quote_ticks_id_seq'),
  capture_ts    timestamptz NOT NULL,           -- FEED-05 capture (partition key)
  instrument_id bigint NOT NULL,
  md_line_id    bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('trade','quote','summary')),
  source_ts     timestamptz,                    -- FEED-05 provider-published (Cboe last_trade_time, ET → UTC)
  publish_ts    timestamptz,                    -- FEED-05 plant publish
  src_seq       bigint,                         -- Cboe seqno (plant drops seq ≤ last)
  price         numeric(18,6),
  size          bigint,
  bid           numeric(18,6), ask numeric(18,6), bid_size int, ask_size int,
  open          numeric(18,6), high numeric(18,6), low numeric(18,6), prev_close numeric(18,6),
  volume        bigint,
  iv30          numeric(10,6),
  tick_dir      char(1) CHECK (tick_dir IN ('u','d','f')),
  conditions    text[] NOT NULL DEFAULT '{}',   -- FEED-07 placeholder: no reachable source publishes sale conditions; 'delayed','synthetic_from_poll'
  session_state session_state,
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (capture_ts, tick_id)
) PARTITION BY RANGE (capture_ts);
CREATE TABLE quote_ticks_default PARTITION OF quote_ticks DEFAULT;
CREATE INDEX quote_ticks_instrument_idx ON quote_ticks (instrument_id, capture_ts DESC);    -- one session, one name (< 2 s budget)
CREATE INDEX quote_ticks_line_idx       ON quote_ticks (md_line_id, capture_ts DESC);

CREATE TABLE option_quotes (                    -- Cboe chain snapshots (greeks/IV as published), while an oc:/q: subscriber exists
  capture_ts               timestamptz NOT NULL,
  instrument_id            bigint NOT NULL,     -- option contract instrument
  underlying_instrument_id bigint NOT NULL,
  md_line_id               bigint NOT NULL,
  bid numeric(14,4), ask numeric(14,4), bid_size int, ask_size int,
  last numeric(14,4), last_ts timestamptz, prev_close numeric(14,6),
  volume int, open_interest int,
  iv numeric(10,6), delta numeric(10,6), gamma numeric(12,8), vega numeric(12,6), theta numeric(12,6), rho numeric(12,6), theo numeric(14,6),
  underlying_px            numeric(18,6),
  provenance_id            bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (capture_ts, instrument_id)
) PARTITION BY RANGE (capture_ts);
CREATE TABLE option_quotes_default PARTITION OF option_quotes DEFAULT;
CREATE INDEX option_quotes_underlying_idx ON option_quotes (underlying_instrument_id, capture_ts DESC);   -- OMON latest chain
CREATE INDEX option_quotes_contract_idx   ON option_quotes (instrument_id, capture_ts DESC);

CREATE TABLE quote_snapshots (                  -- warm tier: last composite QuoteState per instrument for plant/warm.ts (STOR-05, BUS-01)
  instrument_id bigint PRIMARY KEY,
  subject       text NOT NULL,                  -- 'q:42'
  seq           bigint NOT NULL,
  state         jsonb NOT NULL,                 -- core QuoteState (fields, fieldTs, ts, session, prov, lines, dq)
  updated_at    timestamptz NOT NULL
);

CREATE TABLE eod_snapshots (                    -- serves the 'eod' tier (plant/eod.ts) and the missing-close DQ check (BUS-06, OPS-03)
  instrument_id bigint NOT NULL,
  session_date  date NOT NULL,
  fields        jsonb NOT NULL,                 -- PX_OFFICIAL_CLOSE, PX_CLOSE_1D, PX_OPEN/HIGH/LOW, PX_VOLUME
  close_ts      timestamptz NOT NULL,           -- session close instant (ts.src for the eod view)
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (instrument_id, session_date)
);

CREATE TABLE fx_rates (                         -- ECB reference rates via frankfurter (30 currencies vs USD), for currency conversion in CHRT-03 / PORT
  base_ccy      char(3) NOT NULL,
  quote_ccy     char(3) NOT NULL,
  rate_date     date NOT NULL,
  rate          numeric(18,8) NOT NULL,         -- quote per 1 base
  source_id     text NOT NULL,                  -- 'frankfurter' | 'yahoo.chart'
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (base_ccy, quote_ccy, rate_date, source_id)
);

CREATE TABLE short_interest (                   -- FINRA consolidated short interest
  instrument_id    bigint NOT NULL,
  settlement_date  date NOT NULL,
  short_qty        bigint,
  prev_short_qty   bigint,
  avg_daily_volume bigint,
  days_to_cover    numeric(10,2),
  change_pct       numeric(10,4),
  revision         boolean NOT NULL DEFAULT false,
  provenance_id    bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (instrument_id, settlement_date)
);

CREATE TABLE etf_holdings (                     -- N-PORT / SSGA holdings (HDS fallback when 13F is not feasible; MEMB source rows)
  etf_instrument_id     bigint NOT NULL,
  as_of_date            date NOT NULL,
  source_id             text NOT NULL,          -- 'sec.archives' | 'ssga.holdings'
  line_no               int NOT NULL,           -- position in the file (stable within one file)
  holding_instrument_id bigint,                 -- resolved via CUSIP → ISIN → alias; NULL when unresolved (data_exceptions row)
  name                  text NOT NULL,
  cusip char(9), isin char(12), lei char(20), sedol char(7), ticker text,
  shares                numeric(20,4),
  market_value          numeric(20,2),
  weight                numeric(12,10),
  asset_cat             text,                   -- N-PORT assetCat 'EC','DBT','STIV'
  issuer_cat            text,                   -- 'CORP'
  country               char(2),
  provenance_id         bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (etf_instrument_id, as_of_date, source_id, line_no)
);
CREATE INDEX etf_holdings_holding_idx ON etf_holdings (holding_instrument_id, as_of_date DESC) WHERE holding_instrument_id IS NOT NULL;

CREATE TABLE vol_surfaces (                     -- ANAL-04 historical surface storage (derived; SVI per expiry)
  underlying_instrument_id bigint NOT NULL,
  as_of          timestamptz NOT NULL,
  expiry         date NOT NULL,
  forward        numeric(18,6) NOT NULL,
  atm_iv         numeric(10,6),
  svi            jsonb NOT NULL,                -- {a,b,rho,m,sigma,rmse,n}
  engine_name    text NOT NULL, engine_version text NOT NULL, inputs_hash char(64) NOT NULL,   -- ANAL-08
  provenance_ids bigint[] NOT NULL,
  PRIMARY KEY (underlying_instrument_id, as_of, expiry)
);
```

### 7.3 `packages/server/src/db/partitions.ts`

```ts
export type PartitionUnit = 'day' | 'month' | 'year';
export interface PartitionPlan { column: string; unit: PartitionUnit; aheadUnits: number; retentionSourceId: string | null; retentionFloorDays: number | null }
export const partitionPlans: Record<string, PartitionPlan> = {
  bars_daily:    { column: 'session_date', unit: 'year',  aheadUnits: 1, retentionSourceId: null,           retentionFloorDays: null },
  bars_intraday: { column: 'bar_ts',       unit: 'month', aheadUnits: 2, retentionSourceId: 'yahoo.chart',  retentionFloorDays: null },
  quote_ticks:   { column: 'capture_ts',   unit: 'day',   aheadUnits: 7, retentionSourceId: 'cboe.quotes',  retentionFloorDays: null },
  option_quotes: { column: 'capture_ts',   unit: 'day',   aheadUnits: 7, retentionSourceId: 'cboe.options', retentionFloorDays: null },
  access_log:    { column: 'ts',           unit: 'month', aheadUnits: 2, retentionSourceId: null,           retentionFloorDays: 2557 },  // 7 y (ENTL-04, REG-01)
  usage_events:  { column: 'ts',           unit: 'month', aheadUnits: 2, retentionSourceId: null,           retentionFloorDays: 730 },
};
/** Creates missing partitions from `from` to now + aheadUnits. Moves default-partition rows that fall inside a new
 *  range into it (CREATE TABLE … (LIKE parent INCLUDING ALL); INSERT … FROM default WHERE range; DELETE …; ATTACH)
 *  in one transaction. Returns created partition names. */
export async function ensurePartitions(db: Db, table: keyof typeof partitionPlans, from: Date, now: Date): Promise<string[]>;
/** Drops partitions whose upper bound < now − max(licence_registry.retention_days, retentionFloorDays); never touches
 *  partitions covered by an open legal_holds row (§13). Writes one ingest_runs row per drop. */
export async function dropExpired(db: Db, table: keyof typeof partitionPlans, now: Date): Promise<string[]>;
export function partitionName(table: string, unit: PartitionUnit, start: Date): string;   // 'quote_ticks_d2026_09_15'
```

Query budgets these support (NFR table): 1 year of daily bars = PK range scan across at most two yearly
partitions, ≈ 252 rows (< 5 ms DB time of the 200 ms budget); one session of ticks for one name = one
daily partition, `quote_ticks_instrument_idx`, ≈ 5,800 rows at a 10 s poll (< 2 s budget).

---

## 8. Migration 0008 — filings and point-in-time fundamentals (DATA-06, NEWS-04, STOR-06)

`xbrl_facts` is point-in-time **by construction**: SEC `companyfacts` returns every filed value of a
concept with its `accn` and `filed` date, so a restatement is simply another row with a later
`filed_at`. Nothing is ever overwritten. The only read path filters `filed_at <= knownAt`.

```sql
-- migration: 0008_fundamentals.sql
CREATE TABLE filings (                          -- SEC submissions.recent (accessionNumber, filingDate, reportDate, acceptanceDateTime, form, items, primaryDocument …)
  accession_no     char(20) PRIMARY KEY,        -- '0000320193-26-000020'
  cik              char(10) NOT NULL,
  issuer_id        bigint,                      -- resolved through identifiers CIK (NULL until the issuer exists)
  form             text NOT NULL,               -- '10-K','10-Q','8-K','8-K/A','4','13F-HR','NPORT-P','N-CEN','SC 13G' …
  filed_date       date NOT NULL,
  accepted_at      timestamptz,                 -- acceptanceDateTime: the public-knowledge instant
  report_date      date,
  items            text[] NOT NULL DEFAULT '{}',-- 8-K items '5.02','8.01','9.01'
  primary_doc      text,
  primary_doc_desc text,
  is_xbrl          boolean NOT NULL DEFAULT false,
  is_inline_xbrl   boolean NOT NULL DEFAULT false,
  size_bytes       int,
  url              text NOT NULL,               -- https://www.sec.gov/Archives/edgar/data/<cik>/<accn-no-dashes>/<primary_doc>
  captured_at      timestamptz NOT NULL DEFAULT now(),
  provenance_id    bigint NOT NULL REFERENCES provenance(provenance_id)
);
CREATE INDEX filings_issuer_idx ON filings (issuer_id, filed_date DESC) WHERE issuer_id IS NOT NULL;
CREATE INDEX filings_cik_idx    ON filings (cik, filed_date DESC);
CREATE INDEX filings_form_idx   ON filings (form, filed_date DESC);
CREATE INDEX filings_items_idx  ON filings USING gin (items);                    -- alerts on 8-K item codes

CREATE TABLE xbrl_facts (                       -- one row per (cik, taxonomy, concept, unit, period, accession): the PIT store (STOR-06)
  fact_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cik            char(10) NOT NULL,
  issuer_id      bigint,
  taxonomy       text NOT NULL,                 -- 'us-gaap' | 'dei' | 'ifrs-full'
  concept        text NOT NULL,                 -- 'RevenueFromContractWithCustomerExcludingAssessedTax'
  unit           text NOT NULL,                 -- 'USD','shares','USD/shares','pure'
  period_start   date,                          -- NULL for instant (balance-sheet) facts
  period_end     date NOT NULL,
  fy             smallint,
  fp             text,                          -- 'FY','Q1','Q2','Q3'
  form           text NOT NULL,
  accession_no   char(20) NOT NULL,
  filed_at       date NOT NULL,                 -- SEC `filed` — the point-in-time key
  frame          text,                          -- 'CY2026Q2' / 'CY2024Q4I' — SEC's canonical-period tag (NULL when omitted)
  value          numeric(28,6) NOT NULL,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  provenance_id  bigint NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT xbrl_facts_period_chk CHECK (period_start IS NULL OR period_start < period_end)
);
-- period_start is nullable, so the natural key is a unique index with COALESCE rather than a UNIQUE constraint
CREATE UNIQUE INDEX xbrl_facts_natural_uniq ON xbrl_facts (cik, taxonomy, concept, unit, period_end, COALESCE(period_start, '0001-01-01'::date), accession_no);
CREATE INDEX xbrl_facts_pit_idx   ON xbrl_facts (cik, taxonomy, concept, unit, period_end DESC, filed_at DESC);   -- FA/EE PIT reads
CREATE INDEX xbrl_facts_filed_idx ON xbrl_facts (cik, filed_at DESC);

CREATE TABLE xbrl_frames (                      -- SEC frames API: one value per CIK for a canonical period — the EQS cross-section store
  taxonomy      text NOT NULL,
  concept       text NOT NULL,                  -- 'Assets'
  unit          text NOT NULL,                  -- 'USD'
  frame         text NOT NULL,                  -- 'CY2024Q4I'
  cik           char(10) NOT NULL,
  issuer_id     bigint,
  accession_no  char(20) NOT NULL,
  period_end    date NOT NULL,
  value         numeric(28,6) NOT NULL,
  filed_at      date,                           -- from the matching xbrl_facts row when known; frames themselves carry no filed date
  captured_at   timestamptz NOT NULL DEFAULT now(),
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (taxonomy, concept, unit, frame, cik)
);
CREATE INDEX xbrl_frames_cik_idx ON xbrl_frames (cik, frame);

CREATE TABLE xbrl_concept_map (                 -- standardisation (DATA-06 "standardisation is the product"): standard item → concept priority list
  mapping_version text NOT NULL,                -- 'std-map/2026.09'
  standard_item   text NOT NULL,                -- 'REVENUE','COGS','GROSS_PROFIT','OPEX','RND','OPER_INC','INT_EXP','PRETAX_INC','TAX','NET_INC','EPS_BASIC',
                                                -- 'EPS_DIL','SHARES_DIL','TOT_ASSETS','TOT_LIAB','EQUITY','CASH','LT_DEBT','CFO','CAPEX','DIV_PAID','BUYBACK','DPS','DDA'
  taxonomy        text NOT NULL,
  concept         text NOT NULL,
  priority        smallint NOT NULL,            -- lower wins when several concepts exist (Revenues=1, RevenueFromContract…=2, SalesRevenueNet=3)
  sign            smallint NOT NULL DEFAULT 1,
  statement       char(2) NOT NULL CHECK (statement IN ('IS','BS','CF')),
  PRIMARY KEY (mapping_version, standard_item, taxonomy, concept)
);

CREATE TABLE fin_statements (                   -- materialised standardised statements, PIT-keyed on filed_at; derived (internal.derived)
  issuer_id       bigint NOT NULL,
  period_end      date   NOT NULL,
  period_type     text   NOT NULL CHECK (period_type IN ('Q','FY','TTM')),
  filed_at        date   NOT NULL,              -- the filing that produced this version; a restatement adds a row
  mapping_version text   NOT NULL,
  fiscal_year     smallint,
  fiscal_period   text,
  accession_no    char(20) NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'USD',
  revenue numeric(28,2), cogs numeric(28,2), gross_profit numeric(28,2), opex numeric(28,2), rnd numeric(28,2),
  oper_inc numeric(28,2), int_exp numeric(28,2), pretax_inc numeric(28,2), tax numeric(28,2), net_inc numeric(28,2),
  eps_basic numeric(12,4), eps_dil numeric(12,4), shares_dil numeric(20,0),
  tot_assets numeric(28,2), tot_liab numeric(28,2), equity numeric(28,2), cash numeric(28,2), lt_debt numeric(28,2),
  cfo numeric(28,2), capex numeric(28,2), fcf numeric(28,2), div_paid numeric(28,2), buyback numeric(28,2), dps numeric(12,6), dda numeric(28,2),
  derived_q4      boolean NOT NULL DEFAULT false,   -- Q4 = FY − (Q1+Q2+Q3)
  as_reported     jsonb NOT NULL,               -- {standard_item: {concept, value, fact_id}} — the FA "as reported" toggle
  built_at        timestamptz NOT NULL DEFAULT now(),
  engine_name     text NOT NULL, engine_version text NOT NULL, inputs_hash char(64) NOT NULL,   -- ANAL-08
  provenance_ids  bigint[] NOT NULL,
  PRIMARY KEY (issuer_id, period_end, period_type, filed_at, mapping_version)
);
CREATE INDEX fin_statements_pit_idx ON fin_statements (issuer_id, period_type, period_end DESC, filed_at DESC);
```

### 8.1 Point-in-time read — `packages/server/src/data/fundamentals.ts`

```ts
/** knownAt is REQUIRED: there is no overload without it (ARCHITECTURE §4.3, §13). Screens pass now; EQS backtests pass the historical date. */
export interface FactsQuery { cik: string; concepts: string[]; unit: string; periods: 'Q' | 'FY' | 'instant'; limit?: number }
export function facts(q: FactsQuery, knownAt: Date): Promise<XbrlFact[]>;
export function statements(issuerId: number, periodType: 'Q'|'FY'|'TTM', knownAt: Date, n?: number): Promise<FinStatement[]>;
export function crossSection(concept: string, frame: string, knownAt: Date): Promise<Array<{ cik: string; value: number }>>;   // EQS
```

```sql
-- latest value known at :known_at for each period (restatements are separate rows with later filed_at)
SELECT DISTINCT ON (period_end, period_start) *
FROM xbrl_facts
WHERE cik = :cik AND taxonomy = 'us-gaap' AND concept = :concept AND unit = :unit
  AND period_start IS NOT NULL AND (period_end - period_start) BETWEEN 80 AND 100      -- quarterly durations
  AND filed_at <= :known_at::date
ORDER BY period_end DESC, period_start DESC, filed_at DESC, accession_no DESC;
```

`server/test/integration/pit.fundamentals.test.ts` inserts the AAPL `Revenues` CY2026Q1 fact
(`accn 0000320193-26-000013`, `filed 2026-05-01`, 111,184,000,000) and a restatement filed
2026-07-31, then proves `facts(…, knownAt = 2026-06-01)` returns the original.

---

## 9. Migration 0009 — econ series with vintages, releases calendar, rate fixings, curves (DATA-07, ANAL-02, ANAL-08)

```sql
-- migration: 0009_econ_curves.sql
CREATE TABLE econ_releases (
  release_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id           text NOT NULL,            -- 'fred.calendar','bls.schedule','fed.fomc'
  provider_release_id text NOT NULL,            -- FRED release id '10' (CPI), BLS 'cpi'/'empsit', 'FOMC'
  name                text NOT NULL,            -- 'Consumer Price Index'
  country             char(2) NOT NULL DEFAULT 'US',
  url                 text,
  importance          smallint NOT NULL DEFAULT 2 CHECK (importance BETWEEN 1 AND 3),
  UNIQUE (source_id, provider_release_id)
);
CREATE TRIGGER econ_releases_source_known BEFORE INSERT OR UPDATE ON econ_releases FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE econ_series (
  series_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_code   text NOT NULL UNIQUE,           -- the code used on the command line, in `e:<seriesCode>` subjects and identifiers SERIES_CODE:
                                                -- 'CPIAUCSL','DGS10','CUUR0000SA0','SOFR','H15_RIFLGFCY10','WB_US_NY.GDP.MKTP.CD','IMF_USA_NGDP_RPCH'
  source_id     text NOT NULL,                  -- 'fred.csv','bls.timeseries','nyfed.rates','fed.h15','worldbank','imf.datamapper','frankfurter'
  provider_code text NOT NULL,                  -- as the provider names it: 'DGS10','CUUR0000SA0','SOFR','RIFLGFCY10_N.B','NY.GDP.MKTP.CD','NGDP_RPCH'
  name          text NOT NULL,
  units         text NOT NULL,                  -- 'Percent', 'Index 1982-1984=100', 'Billions of U.S. dollars'
  frequency     char(1) NOT NULL CHECK (frequency IN ('D','W','M','Q','A')),
  seasonal_adj  text,
  country       char(2) NOT NULL DEFAULT 'US',
  release_id    bigint REFERENCES econ_releases(release_id),
  instrument_id bigint,                         -- the asset_class='econ' instrument (command line, DES, GP)
  decimals      smallint NOT NULL DEFAULT 2,
  first_obs_date date, last_obs_date date, last_updated_at timestamptz,
  UNIQUE (source_id, provider_code)
);
CREATE INDEX econ_series_name_trgm ON econ_series USING gin (name gin_trgm_ops);
CREATE TRIGGER econ_series_source_known BEFORE INSERT OR UPDATE ON econ_series FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE econ_observations (                -- vintage = when this value became known to us; a revision adds a row, never overwrites
  series_id     bigint NOT NULL REFERENCES econ_series(series_id),
  obs_date      date NOT NULL,                  -- period start (monthly: first of month; daily: the day)
  vintage_at    timestamptz NOT NULL,           -- capture time of the poll that first showed this value
  value         numeric(20,6),                  -- NULL = '.', '-', 'ND' with status='missing'
  status        text NOT NULL DEFAULT 'final' CHECK (status IN ('final','preliminary','revised','missing')),
  footnote      text,                           -- BLS footnote text
  is_latest     boolean NOT NULL DEFAULT true,  -- maintained by the ingest upsert: exactly one latest per (series, obs_date)
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (series_id, obs_date, vintage_at)
);
CREATE UNIQUE INDEX econ_observations_latest_uniq ON econ_observations (series_id, obs_date) WHERE is_latest;
CREATE INDEX econ_observations_pit_idx ON econ_observations (series_id, obs_date DESC, vintage_at DESC);

CREATE TABLE rate_fixings (                     -- full NY Fed / H.15 record per fixing (percentiles, volume, target range, averages, index); headline value also in econ_observations
  rate_code          text NOT NULL,             -- 'SOFR','EFFR','OBFR','TGCR','BGCR','SOFRAI'
  effective_date     date NOT NULL,
  vintage_at         timestamptz NOT NULL,      -- revisionIndicator <> '' → new vintage
  rate               numeric(12,8),             -- percentRate (NULL for SOFRAI)
  pct_1  numeric(12,8), pct_25 numeric(12,8), pct_75 numeric(12,8), pct_99 numeric(12,8),
  volume_bn          numeric(14,2),
  target_from        numeric(8,4), target_to numeric(8,4),   -- EFFR only
  avg_30d numeric(12,8), avg_90d numeric(12,8), avg_180d numeric(12,8), index_value numeric(18,10),   -- SOFRAI
  revision_indicator text,
  is_latest          boolean NOT NULL DEFAULT true,
  provenance_id      bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (rate_code, effective_date, vintage_at)
);
CREATE UNIQUE INDEX rate_fixings_latest_uniq ON rate_fixings (rate_code, effective_date) WHERE is_latest;

CREATE TABLE econ_release_events (              -- ECO calendar
  event_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id    bigint NOT NULL REFERENCES econ_releases(release_id),
  scheduled_at  timestamptz NOT NULL,           -- BLS '08:30 AM' ET → UTC; FRED calendar date at 08:30 ET with time_known=false
  time_known    boolean NOT NULL DEFAULT true,
  period_label  text NOT NULL,                  -- 'August 2026'
  series_id     bigint REFERENCES econ_series(series_id),   -- headline series when known
  actual        numeric(20,6),
  prior         numeric(20,6),
  revised_prior numeric(20,6),
  consensus     numeric(20,6),                  -- always NULL in v1: no consensus source (BRIEF §2)
  consensus_unavailable_reason text NOT NULL DEFAULT 'NO_SOURCE',
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','released','revised','delayed','cancelled')),
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  UNIQUE (release_id, scheduled_at, period_label)
);
CREATE INDEX econ_release_events_time_idx ON econ_release_events (scheduled_at);

CREATE TABLE fomc_meetings (                    -- WIRP policy-path nodes; from fed.fomc calendar page (curated fixture for 2026)
  meeting_date  date PRIMARY KEY,               -- decision day (second day of a two-day meeting)
  statement_at  timestamptz,                    -- 14:00 ET
  has_sep       boolean NOT NULL DEFAULT false,
  decision_bp   smallint,                       -- filled after the meeting: change in target range, e.g. -25
  provenance_id bigint REFERENCES provenance(provenance_id)
);

CREATE TABLE curves (
  curve_id              text PRIMARY KEY,       -- 'UST_PAR','UST_BILL','UST_CMT','SOFR_FIX','SOFR_OIS' (plant subjects c:UST_PAR, c:SOFR_OIS)
  name                  text NOT NULL,
  currency              char(3) NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('par','bill','cmt','fixing','ois','zero')),
  day_count             text NOT NULL,          -- 'ACT/ACT' par, 'ACT/360' bills/SOFR
  compounding           text NOT NULL CHECK (compounding IN ('semiannual','annual','simple','continuous')),
  source_id             text NOT NULL,          -- 'treasury.yieldcurve','treasury.bills','fed.h15','nyfed.rates','internal.derived'
  default_interpolation text NOT NULL DEFAULT 'monotone_convex' CHECK (default_interpolation IN ('linear_zero','log_linear_df','monotone_convex'))
);
CREATE TRIGGER curves_source_known BEFORE INSERT OR UPDATE ON curves FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE curve_points (                     -- published curve inputs, vintaged
  curve_id      text NOT NULL REFERENCES curves(curve_id),
  curve_date    date NOT NULL,
  tenor         text NOT NULL,                  -- '1M','1.5M','2M','3M','4M','6M','1Y','2Y','3Y','5Y','7Y','10Y','20Y','30Y' | '4WK','6WK','8WK','13WK','17WK','26WK','52WK' | 'ON'
  quote_type    text NOT NULL CHECK (quote_type IN ('par_yield','discount_rate','investment_yield','cmt_yield','ois_rate','zero_rate','fixing')),
  vintage_at    timestamptz NOT NULL,
  tenor_days    int  NOT NULL,
  value         numeric(12,8) NOT NULL,         -- percent
  instrument_id bigint,                         -- on-the-run bill/note for the tenor when known (CUSIP_13WK …)
  maturity_date date,
  is_latest     boolean NOT NULL DEFAULT true,
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (curve_id, curve_date, tenor, quote_type, vintage_at)
);
CREATE UNIQUE INDEX curve_points_latest_uniq ON curve_points (curve_id, curve_date, tenor, quote_type) WHERE is_latest;
CREATE INDEX curve_points_date_idx ON curve_points (curve_id, curve_date DESC) WHERE is_latest;

CREATE TABLE curve_builds (                     -- bootstrapped curves cached by inputs hash (ANAL-08 reproducibility)
  build_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  curve_id       text NOT NULL REFERENCES curves(curve_id),
  curve_date     date NOT NULL,
  valuation_ts   timestamptz NOT NULL,
  method         text NOT NULL,                 -- 'bills+par_bootstrap' | 'ois_bootstrap'
  interpolation  text NOT NULL,
  engine_name    text NOT NULL, engine_version text NOT NULL,
  inputs_hash    char(64) NOT NULL,
  inputs         jsonb NOT NULL,                -- the exact points + settings used
  nodes          jsonb NOT NULL,                -- [{t, df, zero, fwd}]
  provenance_ids bigint[] NOT NULL,
  built_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curve_id, curve_date, method, interpolation, engine_version, inputs_hash)
);
```

Vintage semantics (DATA-07): `fredSeries.ts` compares each polled value with the `is_latest` row; a
different value for an existing `obs_date` inserts a new vintage (`status='revised'`) and flips
`is_latest`. PIT read: `SELECT DISTINCT ON (obs_date) … WHERE vintage_at <= :known_at ORDER BY obs_date,
vintage_at DESC`. `fedRates.ts` writes the headline rate to `econ_observations` (series `SOFR` …) and
the full record to `rate_fixings`; the plant `r:SOFR` subject is fed from `rate_fixings` (`RATE`,
`RATE_P1` … `RATE_VOLUME_BN`, `TARGET_FROM/TO`). `treasuryCurves.ts` writes `UST_PAR` (par yields 1M–30Y
from `BC_*`), `UST_BILL` (`discount_rate` and `investment_yield` rows per `ROUND_B1_*`) and links
`instrument_id` through `CUSIP_*`; `UST_CMT` comes from H.15; `SOFR_OIS` is derived by
`core/analytics/curve/bootstrap.ts` and cached in `curve_builds`.

---

## 10. Migration 0010 — news, entity links, full text (NEWS-01, NEWS-02, NEWS-08, STOR-04)

```sql
-- migration: 0010_news.sql
CREATE TABLE topics (
  topic_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL UNIQUE,         -- 'MARKETS','ECO','POLITICS','TECH','WEALTH','INDUSTRIES','FED','FILINGS','EARNINGS','CA','RATES','FX','AI'
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('feed','sector','theme','region','event','release')),
  parent_topic_id bigint REFERENCES topics(topic_id),
  keywords        text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE news_items (
  news_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id      text NOT NULL,                 -- 'bbg.rss' | 'sec.atom' | 'fed.rss'
  feed           text NOT NULL,                 -- 'markets','economics','politics','technology','wealth','industries','8-K','press_all'
  provider_guid  text NOT NULL,                 -- RSS guid 'TLEUW0KGZAKZ00' | Atom id 'urn:tag:sec.gov,2008:accession-number=…' | Fed URL
  kind           text NOT NULL CHECK (kind IN ('story','video','filing','press_release','fed_release')),
  headline       text NOT NULL,
  summary        text,                          -- description / Atom summary (HTML stripped)
  url            text NOT NULL,
  author         text,                          -- dc:creator
  category       text,                          -- Fed <category>; SEC form type
  cik            char(10),                      -- SEC feed: filer CIK
  items_8k       text[],                        -- ['5.02','9.01']
  lang           char(2) NOT NULL DEFAULT 'en',
  published_at   timestamptz NOT NULL,          -- pubDate / <updated> (FEED-05 src)
  captured_at    timestamptz NOT NULL,          -- our receipt (cap)
  is_correction  boolean NOT NULL DEFAULT false,-- description starts with 'Correct:' / 'Fixes headline'
  machine_generated boolean NOT NULL DEFAULT false,   -- NEWS-08: always false in v1; the column exists so the render rule is enforceable
  tsv            tsvector GENERATED ALWAYS AS (
                   setweight(to_tsvector('english', coalesce(headline, '')), 'A') ||
                   setweight(to_tsvector('english', coalesce(summary, '')),  'B')) STORED,   -- two-arg to_tsvector is IMMUTABLE; STORED generated columns exist in PG 12+
  provenance_id  bigint NOT NULL REFERENCES provenance(provenance_id),
  UNIQUE (source_id, provider_guid)
);
CREATE INDEX news_items_tsv_idx       ON news_items USING gin (tsv);                              -- N full-text search
CREATE INDEX news_items_headline_trgm ON news_items USING gin (headline gin_trgm_ops);           -- fuzzy headline search
CREATE INDEX news_items_published_idx ON news_items (published_at DESC);                          -- TOP
CREATE INDEX news_items_feed_idx      ON news_items (feed, published_at DESC);                    -- n:feed:markets
CREATE INDEX news_items_cik_idx       ON news_items (cik, published_at DESC) WHERE cik IS NOT NULL;
CREATE TRIGGER news_items_source_known BEFORE INSERT ON news_items FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE news_entity_links (                -- NEWS-02 precision-first entity resolution (exact ticker/CIK/name only; no fuzzy links)
  news_id     bigint NOT NULL REFERENCES news_items(news_id) ON DELETE CASCADE,
  entity_kind entity_kind NOT NULL,             -- instrument | issuer | person | topic
  entity_id   bigint NOT NULL,
  confidence  real NOT NULL CHECK (confidence BETWEEN 0 AND 1),   -- 1.0 CIK/ticker exact; 0.95 name exact; 0.9 alias; links < 0.9 are never written
  method      text NOT NULL CHECK (method IN ('cik','ticker_exact','name_exact','name_alias','feed_topic','keyword','manual')),
  PRIMARY KEY (news_id, entity_kind, entity_id)
);
CREATE INDEX news_entity_links_entity_idx ON news_entity_links (entity_kind, entity_id, news_id DESC);   -- CN, n:inst:<id>, n:topic:<code>
```

`news/ingest.ts` upserts on `(source_id, provider_guid)`; `news/entityLink.ts` links a story to an
instrument only on an exact `$TICKER`/`(TICKER)` token or an exact `issuers.name`/`issuer_aliases.alias`
match, and to a topic by `feed`; SEC 8-K entries link by CIK. `body` is never stored for Bloomberg RSS
(link-out only, per the feed's terms). pgvector is unavailable, so STOR-04 "vector search" is recorded
as a gap in TRACEABILITY.md; full-text is GIN on `tsv` plus trigram on `headline`.

---

## 11. Migration 0011 — firms, users, sessions, entitlements, access log, quotas (ENTL-01..06, SEC-01, SEC-02, SEC-03, API-01, API-06)

```sql
-- migration: 0011_users_entitlements.sql
CREATE TABLE firms (
  firm_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL,
  lei            char(20),
  contract_ref   text,
  seat_count     int NOT NULL DEFAULT 1,                 -- reconciled against declarations (ENTL-06)
  retention_days int NOT NULL DEFAULT 2557,              -- messages / access-log retention floor: 7 years (MSG-03, REG-01)
  data_residency text NOT NULL DEFAULT 'us',             -- REG-07 recorded; single region in v1
  policy         jsonb NOT NULL DEFAULT '{}',            -- MSG-03: {permittedCounterpartyFirms:[], disclaimer, ethicalWalls:[{deskA,deskB}]}
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (                            -- a natural person (ENTL-03, SEC-01); personal data — lawful basis in §19
  user_id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id               bigint NOT NULL REFERENCES firms(firm_id),
  email                 text NOT NULL,
  display_name          text NOT NULL,
  desk                  text,                            -- 'Equities PM','Rates' (ethical-wall unit, MSG-03)
  role                  text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','compliance','dataops','helpdesk','newsroom')),   -- 'newsroom' = SEC-06 wall
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','deprovisioned')),
  person_verified_at    timestamptz,                     -- SEC-01 onboarding evidence
  verified_by           bigint,
  mfa_required          boolean NOT NULL DEFAULT false,  -- SEC-02: WebAuthn required when true
  sanctions_screened_at timestamptz,                     -- REG-06 mechanism (manual attestation in v1)
  sanctions_status      text CHECK (sanctions_status IN ('clear','review','blocked')),
  scim_external_id      text,                            -- SEC-01 SSO/SCIM (out of scope; column reserved)
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz,
  deprovisioned_at      timestamptz,
  anonymised_at         timestamptz                      -- REG-04 erasure: email/display_name replaced by 'user-<id>'; access_log kept
);
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email));
CREATE INDEX users_firm_idx ON users (firm_id);

CREATE TABLE user_credentials (                 -- SEC-02 FIDO2/WebAuthn; password kept for dev fallback only
  credential_pk  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(user_id),
  kind           text NOT NULL CHECK (kind IN ('password','webauthn')),
  credential_id  bytea,                                  -- WebAuthn credential id (NULL for password)
  public_key     bytea,
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[],
  aaguid         uuid,
  secret_hash    text,                                   -- crypt(password, gen_salt('bf', 12)) via pgcrypto (password kind only)
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  CONSTRAINT user_credentials_shape CHECK ((kind = 'webauthn' AND credential_id IS NOT NULL AND public_key IS NOT NULL AND secret_hash IS NULL)
                                        OR (kind = 'password' AND secret_hash IS NOT NULL AND credential_id IS NULL))
);
CREATE UNIQUE INDEX user_credentials_webauthn_uniq ON user_credentials (credential_id) WHERE credential_id IS NOT NULL;
CREATE UNIQUE INDEX user_credentials_password_uniq ON user_credentials (user_id) WHERE kind = 'password' AND revoked_at IS NULL;

CREATE TABLE sessions (                         -- ENTL-03 / SEC-03: one active web session per natural person; a new login supersedes the old (4003)
  session_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          bigint NOT NULL REFERENCES users(user_id),
  token_hash       bytea NOT NULL UNIQUE,                -- digest(token, 'sha256'); the token itself is never stored
  client_kind      text NOT NULL CHECK (client_kind IN ('web','api')),
  api_key_id       bigint,                               -- api sessions: api_keys.api_key_id (FK added below)
  device_id        text,                                 -- client-generated stable id (localStorage)
  ip               inet,
  user_agent       text,
  mfa_verified     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text CHECK (revoke_reason IN ('logout','superseded','expired','admin','deprovisioned')),
  superseded_count int NOT NULL DEFAULT 0                -- how many later logins displaced this one's predecessors (ARCHITECTURE §10.7)
);
CREATE UNIQUE INDEX sessions_one_active_web ON sessions (user_id) WHERE client_kind = 'web' AND revoked_at IS NULL;   -- the SEC-03 invariant
CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);

CREATE TABLE api_keys (                         -- API-01: bearer keys bound to a natural person's entitlements
  api_key_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(user_id),
  key_hash     bytea NOT NULL UNIQUE,
  label        text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{data:read,fn:run,ws:subscribe}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
ALTER TABLE sessions ADD CONSTRAINT sessions_api_key_fk FOREIGN KEY (api_key_id) REFERENCES api_keys(api_key_id);

CREATE TABLE entitlement_grants (               -- ENTL-02: effective = licence cap ∩ firm grant ∩ user grant (evaluator rules 3–6)
  grant_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_kind  text NOT NULL CHECK (subject_kind IN ('user','firm')),
  subject_id    bigint NOT NULL,
  source_id     text,                                    -- NULL = all sources
  asset_class   asset_class,                             -- NULL = all
  field_class   field_class,                             -- NULL = all
  max_tier      tier NOT NULL,
  usage_display boolean NOT NULL DEFAULT true,
  usage_export  boolean NOT NULL DEFAULT false,
  usage_api     boolean NOT NULL DEFAULT false,
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  granted_by    bigint,
  contract_ref  text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_grants_range CHECK (valid_from < valid_to)
);
CREATE INDEX entitlement_grants_subject_idx ON entitlement_grants (subject_kind, subject_id) WHERE valid_to = 'infinity';
CREATE INDEX entitlement_grants_source_idx  ON entitlement_grants (source_id) WHERE source_id IS NOT NULL;

CREATE SEQUENCE access_log_id_seq;
CREATE TABLE access_log (                       -- ENTL-04: every data access decision; batched insert; monthly partitions; append-only (§15)
  log_id        bigint NOT NULL DEFAULT nextval('access_log_id_seq'),
  ts            timestamptz NOT NULL,
  user_id       bigint NOT NULL,
  firm_id       bigint NOT NULL,
  session_id    uuid,
  instrument_id bigint,                                  -- NULL for non-instrument reads (econ series id in details)
  field_id      text NOT NULL,
  field_class   field_class NOT NULL,
  source_id     text NOT NULL,
  requested_tier tier NOT NULL,
  tier          tier,                                    -- granted tier (NULL on deny)
  usage         usage_type NOT NULL,
  purpose       text NOT NULL,                           -- function code | route id | 'ws.sub'
  decision      entl_decision NOT NULL,
  reason        text NOT NULL DEFAULT 'OK',              -- core ReasonCode
  trace_id      uuid,
  details       jsonb,
  PRIMARY KEY (ts, log_id)
) PARTITION BY RANGE (ts);
CREATE TABLE access_log_default PARTITION OF access_log DEFAULT;
CREATE INDEX access_log_user_idx    ON access_log (user_id, ts);
CREATE INDEX access_log_declare_idx ON access_log (source_id, field_class, tier, usage, ts);   -- monthly declarations
CREATE INDEX access_log_trace_idx   ON access_log (trace_id) WHERE trace_id IS NOT NULL;

CREATE TABLE usage_declarations (               -- ENTL-06 / DATA-02: generated monthly from access_log by entitlements/declarations.ts
  declaration_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month            date NOT NULL,                        -- first day of month
  source_id        text NOT NULL,
  firm_id          bigint NOT NULL REFERENCES firms(firm_id),
  field_class      field_class NOT NULL,
  tier             tier NOT NULL,
  display_users    int NOT NULL,
  export_users     int NOT NULL,
  api_users        int NOT NULL,
  distinct_users   int NOT NULL,
  instrument_count int NOT NULL,
  data_points      bigint NOT NULL,
  seat_count       int NOT NULL,                         -- firms.seat_count at generation (reconciliation input)
  query_sql_hash   char(64) NOT NULL,                    -- sha256 of the SQL text that produced the row
  generated_at     timestamptz NOT NULL DEFAULT now(),
  reconciled_at    timestamptz,
  billing_ref      text,
  UNIQUE (month, source_id, firm_id, field_class, tier)
);

CREATE TABLE quota_limits (                     -- API-06 (defaults: 500 daily unique instruments, 2 000 000 monthly datapoints, 2 000 concurrent API subs)
  subject_kind             text NOT NULL CHECK (subject_kind IN ('user','firm')),
  subject_id               bigint NOT NULL,
  daily_unique_instruments int NOT NULL DEFAULT 500,
  monthly_data_points      bigint NOT NULL DEFAULT 2000000,
  concurrent_subscriptions int NOT NULL DEFAULT 2000,
  PRIMARY KEY (subject_kind, subject_id)
);
CREATE TABLE quota_counters (
  user_id      bigint NOT NULL REFERENCES users(user_id),
  window_kind  text NOT NULL CHECK (window_kind IN ('day','month')),
  window_start date NOT NULL,
  data_points  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_kind, window_start)
);
CREATE TABLE quota_instruments_seen (
  user_id       bigint NOT NULL,
  day           date NOT NULL,
  instrument_id bigint NOT NULL,
  PRIMARY KEY (user_id, day, instrument_id)
);
```

Evaluator inputs (ARCHITECTURE §10): rule 1 reads `field_licence`, rules 2–3 `licence_registry`,
rules 4–5 `entitlement_grants` (`subject_kind='firm'` then `'user'`, `valid_from <= now() < valid_to`,
matching `source_id IS NULL OR = $src`, `field_class IS NULL OR = $fc`, `asset_class IS NULL OR = $ac`;
effective tier = `min(tier_rank)`), rule 7 the `sessions_one_active_web` index (the supersede is an
`UPDATE … SET revoked_at = now(), revoke_reason = 'superseded'` followed by the insert in one
transaction; the displaced WS gets `bye 4003`; an `access_log` row with `decision='deny',
reason='CONCURRENT_SESSION'` is written), rule 8 `quota_*`, rule 9 `access_log` (ring buffer →
`INSERT … VALUES (…), (…)` every 1 s or 5,000 rows, never on the response path). Seed grants
(`fixtures/seed/entitlements.json`): each firm `max_tier='delayed'`, display+export on every source;
`pm@demo` additionally `usage_api=true`; the `eod`-only test user has a user grant `max_tier='eod'`.

---

## 12. Migration 0012 — workspaces, watchlists, portfolios, annotations, saved searches, alerts (TERM-05, PORT-01, PORT-02, PORT-07, CHRT-05, NEWS-07)

All tables here are client-supplied data: every row carries `firm_id` (denormalised where needed for
RLS) and is covered by the policies in §15.

```sql
-- migration: 0012_workspace_portfolio.sql
CREATE TABLE workspaces (                       -- TERM-05: the whole desk, server-side
  workspace_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(user_id),
  firm_id      bigint NOT NULL REFERENCES firms(firm_id),
  name         text NOT NULL DEFAULT 'default',
  is_active    boolean NOT NULL DEFAULT true,
  layout       jsonb NOT NULL,                  -- WorkspaceLayout (API.md): panels[{id, frameStack[{security, fn, params}], history}], monitors, chart settings, focus
  version      int NOT NULL DEFAULT 1,          -- optimistic concurrency: PUT must send the version it read (409 otherwise)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE UNIQUE INDEX workspaces_active_uniq ON workspaces (user_id) WHERE is_active;
CREATE TRIGGER workspaces_updated BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE watchlists (                       -- W: user-defined, shareable, computed columns
  watchlist_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id   bigint NOT NULL REFERENCES users(user_id),
  firm_id         bigint NOT NULL REFERENCES firms(firm_id),
  name            text NOT NULL,
  columns         jsonb NOT NULL,               -- [{id:'PX_LAST'} | {id:'c1', formula:'PX_LAST/PX_CLOSE_1D-1', label:'Chg', decimals:2}]  (CHRT-07 formula language)
  sort            jsonb NOT NULL DEFAULT '[]',
  group_by        text,
  shared_scope    text NOT NULL DEFAULT 'private' CHECK (shared_scope IN ('private','firm','users')),
  shared_user_ids bigint[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);
CREATE TRIGGER watchlists_updated BEFORE UPDATE ON watchlists FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE watchlist_items (
  watchlist_id  bigint NOT NULL REFERENCES watchlists(watchlist_id) ON DELETE CASCADE,
  position      int NOT NULL,
  instrument_id bigint,                         -- NULL when the row is a formula/basket
  formula       text,                           -- CHRT-07 computed series as a row ('RATIO(AAPL US Equity, SPX Index)')
  label         text,
  note          text,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, position),
  CONSTRAINT watchlist_items_kind CHECK ((instrument_id IS NULL) <> (formula IS NULL))
);
CREATE INDEX watchlist_items_instrument_idx ON watchlist_items (instrument_id) WHERE instrument_id IS NOT NULL;   -- hotset.ts: watchlist members of connected users

CREATE TABLE portfolios (                       -- PORT-07: strictly tenant-isolated (RLS FORCE in §15)
  portfolio_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id                 bigint NOT NULL REFERENCES firms(firm_id),
  owner_user_id           bigint NOT NULL REFERENCES users(user_id),
  name                    text NOT NULL,
  base_currency           char(3) NOT NULL DEFAULT 'USD',
  benchmark_instrument_id bigint,               -- SPX Index / SPY
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, name)
);
CREATE TRIGGER portfolios_updated BEFORE UPDATE ON portfolios FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE portfolio_imports (                -- PORT-01: upload / file drop / API with reconciliation report
  import_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id   bigint NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
  firm_id        bigint NOT NULL,
  uploaded_by    bigint NOT NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  channel        text NOT NULL CHECK (channel IN ('upload','file_drop','api','manual')),
  filename       text,
  as_of_date     date NOT NULL,
  rows_total     int NOT NULL DEFAULT 0,
  rows_ok        int NOT NULL DEFAULT 0,
  rows_error     int NOT NULL DEFAULT 0,
  errors         jsonb NOT NULL DEFAULT '[]',   -- [{row, identifier, column, reason}]
  reconciliation jsonb NOT NULL DEFAULT '{}',   -- {matched, added, removed, quantityDiffs:[{instrumentId, before, after}]}
  status         text NOT NULL CHECK (status IN ('accepted','partial','rejected')),
  provenance_id  bigint REFERENCES provenance(provenance_id)   -- source 'internal.user'
);

CREATE TABLE positions (                        -- PORT-02: multi-asset, multi-currency; one row per (portfolio, lot, as-of)
  position_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id   bigint NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
  firm_id        bigint NOT NULL,               -- denormalised for RLS
  as_of_date     date NOT NULL,
  instrument_id  bigint,                        -- NULL = cash line or unresolved identifier
  raw_identifier text NOT NULL,                 -- what the upload said ('AAPL US', 'US0378331005', 'USD')
  is_cash        boolean NOT NULL DEFAULT false,
  cash_currency  char(3),
  lot_id         text NOT NULL DEFAULT 'default',
  quantity       numeric(24,8) NOT NULL,
  cost_price     numeric(18,6),
  cost_currency  char(3),
  trade_date     date,
  settle_date    date,
  accrued        numeric(18,6) NOT NULL DEFAULT 0,
  recon_status   text NOT NULL DEFAULT 'ok' CHECK (recon_status IN ('ok','unresolved','duplicate','price_missing')),
  import_id      bigint REFERENCES portfolio_imports(import_id),
  UNIQUE (portfolio_id, as_of_date, raw_identifier, lot_id)
);
CREATE INDEX positions_portfolio_idx ON positions (portfolio_id, as_of_date DESC);

CREATE TABLE lots (                             -- PORT-02 lot-level cost basis (open lots; positions are the as-of snapshot)
  lot_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id  bigint NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
  firm_id       bigint NOT NULL,
  instrument_id bigint NOT NULL,
  open_date     date NOT NULL,
  quantity      numeric(24,8) NOT NULL,
  unit_cost     numeric(24,8) NOT NULL,
  currency      char(3) NOT NULL,
  closed_date   date,
  external_ref  text
);
CREATE INDEX lots_portfolio_idx ON lots (portfolio_id, instrument_id) WHERE closed_date IS NULL;

CREATE TABLE chart_annotations (                -- CHRT-05: anchored in data coordinates, shareable
  annotation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES users(user_id),
  firm_id       bigint NOT NULL,
  instrument_id bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('trendline','hline','vline','fib','text','regression_channel','rect')),
  anchors       jsonb NOT NULL,                 -- [{t: epoch_ms, v: number}] (regression: {t0, t1, stdev})
  style         jsonb NOT NULL DEFAULT '{}',
  label         text,
  shared_scope  text NOT NULL DEFAULT 'private' CHECK (shared_scope IN ('private','firm','users')),
  shared_user_ids bigint[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chart_annotations_instrument_idx ON chart_annotations (instrument_id, owner_user_id);
CREATE TRIGGER chart_annotations_updated BEFORE UPDATE ON chart_annotations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE saved_searches (                   -- NEWS-07 saved news searches, EQS / SRCH screen definitions
  search_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES users(user_id),
  firm_id       bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('news','eqs','srch')),
  name          text NOT NULL,
  query         jsonb NOT NULL,                 -- news: {text, instrumentIds[], topics[], feeds[]}; eqs/srch: ScreenCriteria (FUNCTIONS.md)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, kind, name)
);
CREATE TRIGGER saved_searches_updated BEFORE UPDATE ON saved_searches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alerts (                           -- NEWS-07: user-defined triggers on prices, news, filings, calendar events
  alert_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES users(user_id),
  firm_id       bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('price','news','filing','calendar')),
  instrument_id bigint,                         -- price alerts (evaluated on plant deltas)
  condition     jsonb NOT NULL,                 -- price: {field:'PX_LAST', op:'>='|'<='|'crosses', value}; news: {savedSearchId}|{query}; filing: {ciks[], forms[], items[]}; calendar: {releaseId, minutesBefore}
  delivery      text[] NOT NULL DEFAULT '{inapp}',   -- 'inapp' | 'email' | 'push' (email/push are recorded intents in v1)
  status        text NOT NULL DEFAULT 'armed' CHECK (status IN ('armed','paused','fired','deleted')),
  one_shot      boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_fired_at timestamptz
);
CREATE INDEX alerts_armed_price_idx ON alerts (instrument_id) WHERE status = 'armed' AND kind = 'price';
CREATE INDEX alerts_owner_idx       ON alerts (owner_user_id) WHERE status <> 'deleted';

CREATE TABLE alert_events (
  event_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id        bigint NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
  firm_id         bigint NOT NULL,
  fired_at        timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL,               -- {value, newsId, accessionNo, eventId, provenanceId}
  delivered       jsonb NOT NULL DEFAULT '{}',  -- {inapp: ts, email: null, push: null}
  acknowledged_at timestamptz
);
CREATE INDEX alert_events_alert_idx ON alert_events (alert_id, fired_at DESC);
```

---

## 13. Migration 0013 — messaging (MSG-01, MSG-02, MSG-03, MSG-04, MSG-06)

```sql
-- migration: 0013_messaging.sql
CREATE TABLE rooms (
  room_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('dm','group','firm','helpdesk')),
  name           text,
  firm_id        bigint REFERENCES firms(firm_id),   -- NULL for cross-firm dm/group rooms (policy checked per member firm)
  scope          text NOT NULL DEFAULT 'internal' CHECK (scope IN ('internal','external')),
  created_by     bigint NOT NULL REFERENCES users(user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  retention_days int NOT NULL DEFAULT 2557,          -- MSG-03 / REG-01: ≥ firm retention; purge never below 7 years
  disclaimer     text,                               -- MSG-03 shown on join
  wall_tag       text,                               -- MSG-03 / SEC-06 ethical wall: members' desks must all carry this tag (enforced by messaging/service.ts)
  policy         jsonb NOT NULL DEFAULT '{}'         -- {permittedFirms:[], allowExternal:false}
);

CREATE TABLE room_members (
  room_id   bigint NOT NULL REFERENCES rooms(room_id),
  user_id   bigint NOT NULL REFERENCES users(user_id),
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner','supervisor')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user_idx ON room_members (user_id) WHERE left_at IS NULL;

CREATE TABLE messages (                         -- MSG-02 / REG-01 WORM: append-only, hash-chained per room (trigger + REVOKE in §15)
  message_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id        bigint NOT NULL REFERENCES rooms(room_id),
  seq            bigint NOT NULL,                    -- per-room sequence, assigned by the chain trigger
  sender_user_id bigint NOT NULL REFERENCES users(user_id),
  sender_firm_id bigint NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  body           text NOT NULL,
  attachments    jsonb NOT NULL DEFAULT '[]',        -- MSG-04: [{kind:'security'|'chart'|'function'|'portfolio'|'watchlist', ref:{…}, params}] rendered live within the recipient's entitlements
  structured     jsonb,                              -- MSG-06 shape only: {type:'ioi'|'rfq', side, instrumentId, qty, price} — display only, no execution
  client_msg_id  uuid NOT NULL,                      -- idempotent send
  prev_hash      bytea,
  hash           bytea NOT NULL,                     -- sha256(prev_hash || room_id || seq || sender || sent_at || body || attachments)
  trace_id       uuid,
  UNIQUE (room_id, seq),
  UNIQUE (room_id, client_msg_id)
);
CREATE INDEX messages_room_time_idx ON messages (room_id, sent_at DESC);
CREATE INDEX messages_fts_idx       ON messages USING gin (to_tsvector('english', body));   -- supervisory search / production on request

CREATE TABLE message_reads (
  room_id       bigint NOT NULL,
  user_id       bigint NOT NULL,
  last_read_seq bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE legal_holds (                      -- MSG-02: while open, nothing in scope may be purged (partitions.ts and retentionPurge check this)
  hold_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id     bigint NOT NULL REFERENCES firms(firm_id),
  scope       jsonb NOT NULL,                        -- {userIds:[], roomIds:[], from, to}
  reason      text NOT NULL,
  created_by  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by bigint
);
CREATE INDEX legal_holds_open_idx ON legal_holds (firm_id) WHERE released_at IS NULL;

CREATE TABLE surveillance_lexicon (             -- MSG-02 lexicon-based surveillance
  term_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id  bigint REFERENCES firms(firm_id),         -- NULL = global list
  pattern  text NOT NULL,                            -- case-insensitive regex
  severity smallint NOT NULL DEFAULT 2 CHECK (severity BETWEEN 1 AND 3),
  active   boolean NOT NULL DEFAULT true,
  note     text
);

CREATE TABLE surveillance_hits (
  hit_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id    bigint NOT NULL REFERENCES messages(message_id),
  term_id       bigint NOT NULL REFERENCES surveillance_lexicon(term_id),
  matched_text  text NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  review_status text NOT NULL DEFAULT 'open' CHECK (review_status IN ('open','escalated','cleared')),
  reviewed_by   bigint,
  reviewed_at   timestamptz,
  reviewer_note text,
  UNIQUE (message_id, term_id)
);
CREATE INDEX surveillance_hits_open_idx ON surveillance_hits (detected_at DESC) WHERE review_status = 'open';

CREATE TABLE message_reviews (                  -- supervisory review queue (random sample + manual flags)
  review_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id       bigint NOT NULL REFERENCES messages(message_id),
  flagged_by       text NOT NULL CHECK (flagged_by IN ('lexicon','random_sample','manual')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','escalated')),
  reviewer_user_id bigint,
  reviewed_at      timestamptz,
  note             text
);
```

Hash chain, sequence assignment and the append-only guarantee are installed in §15 (they need the
`terminal_app` role for the revokes). Production on request (REG-01) is
`GET /api/v1/admin/export/messages?room&from&to`, which streams rows in `seq` order with their hashes
so a recipient can re-verify the chain.

---

## 14. Migration 0014 — ops: usage events, help tickets, data quality, ingest runs, exceptions (FUNC-04, TERM-09, OPS-03, OPS-04, OPS-07, REF-10, QA-03)

```sql
-- migration: 0014_ops.sql
CREATE SEQUENCE usage_events_id_seq;
CREATE TABLE usage_events (                     -- FUNC-04: every launch, param change, page, export, help, search selection …
  event_id      bigint NOT NULL DEFAULT nextval('usage_events_id_seq'),
  ts            timestamptz NOT NULL,
  user_id       bigint NOT NULL,
  firm_id       bigint NOT NULL,
  session_id    uuid,
  panel_id      text,
  kind          text NOT NULL CHECK (kind IN ('fn.launch','fn.param','fn.page','fn.export','fn.help','search.select','cmd.parse_error',
                                              'panel.switch','ws.subscribe','ws.slow','ws.resync','ticket.open')),
  code          text,                           -- function code
  params_hash   text,                           -- sha256 of canonical params JSON
  instrument_id bigint,
  duration_ms   int,
  trace_id      uuid,
  details       jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (ts, event_id)
) PARTITION BY RANGE (ts);
CREATE TABLE usage_events_default PARTITION OF usage_events DEFAULT;
CREATE INDEX usage_events_code_idx  ON usage_events (kind, code, ts);      -- the roadmap query (ARCHITECTURE §11)
CREATE INDEX usage_events_user_idx  ON usage_events (user_id, ts);
CREATE INDEX usage_events_trace_idx ON usage_events (trace_id) WHERE trace_id IS NOT NULL;

CREATE TABLE help_tickets (                     -- TERM-09: second HELP press opens a ticket record (no live analyst in v1)
  ticket_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(user_id),
  firm_id       bigint NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  panel_id      text,
  function_code text,
  instrument_id bigint,
  params        jsonb,
  screen_state  jsonb NOT NULL DEFAULT '{}',    -- visible fields + their provenance indexes
  trace_id      uuid,
  question      text NOT NULL,
  room_id       bigint REFERENCES rooms(room_id),   -- helpdesk room created for the ticket
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  answer        text,
  answered_by   bigint,
  answered_at   timestamptz
);
CREATE INDEX help_tickets_open_idx ON help_tickets (opened_at DESC) WHERE status = 'open';

CREATE TABLE ingest_runs (                      -- one row per scheduler job run (ARCHITECTURE §7.1)
  run_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      text NOT NULL,                    -- 'cboe.quotes.poll', 'yahooDaily', 'partitionMaintenance' …
  source_id   text,                             -- NULL for internal jobs
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  status      text NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  fetched     int NOT NULL DEFAULT 0,
  inserted    int NOT NULL DEFAULT 0,
  updated     int NOT NULL DEFAULT 0,
  skipped     int NOT NULL DEFAULT 0,
  errors      jsonb NOT NULL DEFAULT '[]',      -- JobError[] {code, message, url?, requestKey?}
  trace_id    uuid
);
CREATE INDEX ingest_runs_job_idx ON ingest_runs (job_id, started_at DESC);
ALTER TABLE provenance ADD CONSTRAINT provenance_run_fk FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id);

CREATE TABLE dq_events (                        -- OPS-03 / QA-03 / BUS-04 (every widen/shed/close is a row)
  dq_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('stale_tick','cross_source_divergence','missing_close','field_population','poll_anomaly',
                                              'provider_circuit_open','reconcile_mismatch','parse_error','default_partition_nonempty',
                                              'ref_orphans','ws_backpressure','plant_degraded','replay_diff')),
  severity      text NOT NULL CHECK (severity IN ('info','warn','error')),
  instrument_id bigint,
  md_line_id    bigint,
  source_id     text,
  subject       text,                           -- plant subject or table name
  details       jsonb NOT NULL DEFAULT '{}',    -- {expected, actual, diffPct, sessionId …}
  resolved_at   timestamptz
);
CREATE INDEX dq_events_open_idx ON dq_events (kind, ts DESC) WHERE resolved_at IS NULL;
CREATE INDEX dq_events_ts_idx   ON dq_events (ts DESC);

CREATE TABLE data_exceptions (                  -- REF-10 exception queue: source conflicts, parse failures, manual review, reported errors, with SLA
  exception_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  kind             text NOT NULL CHECK (kind IN ('source_conflict','missing_field','parse_error','manual_review','reported_error','unresolved_identifier','ca_review')),
  entity_kind      entity_kind,
  entity_id        bigint,
  field            text,
  candidates       jsonb NOT NULL DEFAULT '[]', -- [{sourceId, provenanceId, value}]
  reported_by      bigint,                      -- users.user_id for reported errors
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  assignee_user_id bigint,
  resolved_by      bigint,
  resolution       jsonb,                       -- {chosenProvenanceId, versionId, note}
  resolved_at      timestamptz,
  sla_due_at       timestamptz
);
CREATE INDEX data_exceptions_open_idx ON data_exceptions (sla_due_at) WHERE status = 'open';

CREATE TABLE status_incidents (                 -- OPS-04 status page
  incident_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  component   text NOT NULL,                    -- 'provider:cboe.quotes','plant','ws','db'
  severity    text NOT NULL CHECK (severity IN ('info','degraded','outage')),
  title       text NOT NULL,
  updates     jsonb NOT NULL DEFAULT '[]'       -- [{ts, text}]
);

CREATE TABLE schema_meta (                      -- 'field_dictionary_version','concept_map_version','seed_fixture_sha'
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_versions (                  -- in-memory caches (licenceRegistry.ts, evaluator) reload when a version changes
  name       text PRIMARY KEY,                  -- 'entitlements', 'calendars', 'universe'
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO config_versions (name) VALUES ('entitlements'), ('calendars'), ('universe');

CREATE FUNCTION bump_config_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO config_versions (name, version, updated_at) VALUES (TG_ARGV[0], 1, now())
  ON CONFLICT (name) DO UPDATE SET version = config_versions.version + 1, updated_at = now();
  RETURN NULL;
END $$;
CREATE TRIGGER licence_registry_bump   AFTER INSERT OR UPDATE ON licence_registry   FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version('entitlements');
CREATE TRIGGER field_licence_bump      AFTER INSERT OR UPDATE OR DELETE ON field_licence FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version('entitlements');
CREATE TRIGGER entitlement_grants_bump AFTER INSERT OR UPDATE OR DELETE ON entitlement_grants FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version('entitlements');
CREATE TRIGGER calendar_holidays_bump  AFTER INSERT OR UPDATE OR DELETE ON calendar_holidays FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version('calendars');
```

The trace query (OPS-07) `GET /api/v1/admin/trace/:traceId` joins `access_log.trace_id`,
`usage_events.trace_id`, `provenance.trace_id`, `ingest_runs.trace_id`, `messages.trace_id` and
`help_tickets.trace_id` — every table above indexes it.

---

## 15. Migration 0015 — application role, grants, tenant isolation, WORM and the hash chain (PORT-07, SEC-05, SEC-06, MSG-02, REG-01, ENTL-04)

```sql
-- migration: 0015_roles_rls_worm.sql
-- 15.a Role (cluster-wide; bloomberg_dev and bloomberg_test share it, so create only when absent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'terminal_app') THEN
    CREATE ROLE terminal_app LOGIN;             -- password set by ops: ALTER ROLE terminal_app PASSWORD '…'; DATABASE_URL uses it
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO terminal_app', current_database());   -- bloomberg_dev or bloomberg_test
END $$;
GRANT USAGE ON SCHEMA public TO terminal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO terminal_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO terminal_app;          -- views included (SELECT)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO terminal_app;     -- future partitions
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO terminal_app;

-- 15.b Mutable application tables: full UPDATE, DELETE where the product deletes
GRANT UPDATE ON firms, users, user_credentials, sessions, api_keys, entitlement_grants, quota_limits, quota_counters,
                usage_declarations, workspaces, watchlists, watchlist_items, portfolios, portfolio_imports, positions, lots,
                chart_annotations, saved_searches, alerts, alert_events, rooms, room_members, message_reads, legal_holds,
                surveillance_lexicon, surveillance_hits, message_reviews, help_tickets, ingest_runs, dq_events, data_exceptions,
                status_incidents, schema_meta, config_versions, quote_snapshots, eod_snapshots,
                econ_observations, rate_fixings, curve_points, econ_release_events, econ_series, econ_releases, fomc_meetings,
                filings, xbrl_frames, bars_daily, bars_intraday, fx_rates, short_interest, etf_holdings, calendar_holidays,
                calendar_sessions, calendars, exchanges, classification_codes, classification_schemes, indices, issuer_aliases,
                topics, field_licence,
                news_items, news_entity_links, vol_surfaces
  TO terminal_app;
-- news_items / news_entity_links: NEWS-01/NEWS-02 re-ingest is an upsert on (source_id, provider_guid) — a correction
-- rewrites headline/summary/is_correction, and a later linking run rewrites confidence/method on an existing link.
-- vol_surfaces: ANAL-04 re-fits the same (underlying_instrument_id, as_of, expiry) key. Without UPDATE all three writers
-- raise "permission denied for table" on their second run, which is exactly the idempotency the replay tests assert.
GRANT DELETE ON watchlist_items, watchlists, positions, lots, chart_annotations, saved_searches, alerts, alert_events,
                room_members, message_reads, quota_instruments_seen, quota_counters, field_licence, issuer_aliases,
                calendar_holidays, calendar_sessions, dq_events
  TO terminal_app;

-- 15.c Bitemporal tables: UPDATE is allowed (the bt_guard trigger restricts it to closing tx_to); DELETE never.
GRANT UPDATE ON licence_registry, issuers, issues, instruments, listings, md_lines, identifiers, govt_terms, option_terms,
                future_terms, fund_terms, index_terms, fx_terms, rate_terms, entity_classifications, index_members, people,
                entity_relations, corporate_actions
  TO terminal_app;
-- (no DELETE grant on any of them; the default grant above is SELECT, INSERT only)

-- 15.d WORM tables (REG-01, MSG-02, ENTL-04, DATA-10): no UPDATE, no DELETE, plus triggers as defence in depth against the owner role
CREATE FUNCTION worm_block() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'table % is append-only (WORM)', TG_TABLE_NAME; END $$;
CREATE TRIGGER messages_worm     BEFORE UPDATE OR DELETE ON messages     FOR EACH ROW EXECUTE FUNCTION worm_block();
CREATE TRIGGER access_log_worm   BEFORE UPDATE OR DELETE ON access_log   FOR EACH ROW EXECUTE FUNCTION worm_block();   -- BEFORE row triggers on partitioned tables: PG 13+
CREATE TRIGGER provenance_worm   BEFORE UPDATE OR DELETE ON provenance   FOR EACH ROW EXECUTE FUNCTION worm_block();
CREATE TRIGGER usage_events_worm BEFORE UPDATE OR DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION worm_block();
CREATE TRIGGER xbrl_facts_worm   BEFORE UPDATE OR DELETE ON xbrl_facts   FOR EACH ROW EXECUTE FUNCTION worm_block();   -- STOR-06: restatements are new rows
-- Retention drops happen at partition level (DROP TABLE <partition>) by the owner role and never touch rows under an open legal hold.

-- 15.d.1 Partition maintenance role (STOR-05, STOR-07, OPS-03)
-- `terminal_app` holds USAGE on the schema plus SELECT/INSERT (and the UPDATE/DELETE lists above). That is deliberately
-- not enough to maintain partitions: CREATE TABLE needs CREATE on the schema, DROP TABLE needs ownership of the
-- partition, and ATTACH/DETACH needs ownership of the parent. Granting terminal_app ownership of the partitioned
-- parents would also hand it the power to disable the 15.d WORM triggers on access_log and usage_events, which is the
-- one thing those triggers exist to prevent. So maintenance gets its own role, which owns the six partitioned parents:
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'terminal_maint') THEN
    CREATE ROLE terminal_maint LOGIN;          -- DATABASE_URL_MAINT; password set by ops
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO terminal_maint', current_database());
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO terminal_maint;
ALTER TABLE bars_daily    OWNER TO terminal_maint;
ALTER TABLE bars_intraday OWNER TO terminal_maint;
ALTER TABLE quote_ticks   OWNER TO terminal_maint;
ALTER TABLE option_quotes OWNER TO terminal_maint;
ALTER TABLE access_log    OWNER TO terminal_maint;
ALTER TABLE usage_events  OWNER TO terminal_maint;
-- ownership moves only the six parents (and, by inheritance of the OWNER on new children, every partition
-- terminal_maint creates); the 0016 partitions are re-owned in the same statement block:
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
           JOIN pg_class parent ON parent.oid = i.inhparent
           WHERE parent.relname IN ('bars_daily','bars_intraday','quote_ticks','option_quotes','access_log','usage_events')
  LOOP EXECUTE format('ALTER TABLE %I OWNER TO terminal_maint', p.relname); END LOOP;
END $$;
-- terminal_app keeps exactly the access it had (ownership changes do not revoke grants, but the default privileges
-- above are attached to the migration owner, so restate them for the new owner's future partitions):
ALTER DEFAULT PRIVILEGES FOR ROLE terminal_maint IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO terminal_app;
GRANT SELECT, INSERT ON bars_daily, bars_intraday, quote_ticks, option_quotes, access_log, usage_events TO terminal_app;
GRANT UPDATE ON bars_daily, bars_intraday TO terminal_app;                 -- as listed in 15.b; access_log/usage_events stay WORM
-- The WORM triggers of 15.d still fire for terminal_maint: DROP TABLE on a partition is DDL, not a row UPDATE/DELETE,
-- so retention drops work while row-level rewrites remain blocked for every role.
-- Consequence for the server (§15.1): `db/client.ts` opens a second, single-connection pool on DATABASE_URL_MAINT used
-- only by `db/partitions.ts#ensurePartitions` / `#dropExpired` and by `retentionPurge`. Every other statement in the
-- process runs on the terminal_app pool. On PG 14 the legacy PUBLIC CREATE grant on schema public would mask half of
-- this in development and fail only in a hardened deployment, so the split is made explicit here rather than discovered.

-- 15.e Per-room hash chain and sequence (MSG-02). The advisory lock serialises concurrent sends into one room.
CREATE FUNCTION messages_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev bytea; last_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('room:' || NEW.room_id::text));
  SELECT hash, seq INTO prev, last_seq FROM messages WHERE room_id = NEW.room_id ORDER BY seq DESC LIMIT 1;
  NEW.seq       := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := prev;
  NEW.hash      := digest(coalesce(prev, '\x'::bytea)
                          || convert_to(NEW.room_id::text || '|' || NEW.seq::text || '|' || NEW.sender_user_id::text || '|'
                                        || to_char(NEW.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
                                        || NEW.body || '|' || NEW.attachments::text, 'UTF8'),
                          'sha256');
  RETURN NEW;
END $$;
CREATE TRIGGER messages_chain_trg BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_chain();

-- 15.f Tenant isolation (PORT-07, SEC-05). db/client.ts sets app.user_id / app.firm_id / app.role per request transaction.
-- FORCE makes the policies apply to the table owner as well, so even migrations/seed/ingest cannot read tenant data
-- without a firm context. A missing context (ingest jobs, the newsroom role) yields zero rows and rejects writes.
ALTER TABLE portfolios        ENABLE ROW LEVEL SECURITY; ALTER TABLE portfolios        FORCE ROW LEVEL SECURITY;
ALTER TABLE positions         ENABLE ROW LEVEL SECURITY; ALTER TABLE positions         FORCE ROW LEVEL SECURITY;
ALTER TABLE lots              ENABLE ROW LEVEL SECURITY; ALTER TABLE lots              FORCE ROW LEVEL SECURITY;
ALTER TABLE portfolio_imports ENABLE ROW LEVEL SECURITY; ALTER TABLE portfolio_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_searches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE help_tickets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY; ALTER TABLE messages          FORCE ROW LEVEL SECURITY;
ALTER TABLE rooms             ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reads     ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_holds       ENABLE ROW LEVEL SECURITY;
ALTER TABLE surveillance_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reviews   ENABLE ROW LEVEL SECURITY;

CREATE POLICY portfolios_tenant ON portfolios USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());
CREATE POLICY positions_tenant  ON positions  USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());
CREATE POLICY lots_tenant       ON lots       USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());
CREATE POLICY imports_tenant    ON portfolio_imports USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());
CREATE POLICY workspaces_owner  ON workspaces USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY watchlists_scope  ON watchlists
  USING (owner_user_id = app_user_id()
         OR (firm_id = app_firm_id() AND (shared_scope = 'firm' OR (shared_scope = 'users' AND app_user_id() = ANY (shared_user_ids)))))
  WITH CHECK (owner_user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY watchlist_items_scope ON watchlist_items
  USING (EXISTS (SELECT 1 FROM watchlists w WHERE w.watchlist_id = watchlist_items.watchlist_id))      -- delegates to watchlists' policy
  WITH CHECK (EXISTS (SELECT 1 FROM watchlists w WHERE w.watchlist_id = watchlist_items.watchlist_id AND w.owner_user_id = app_user_id()));
CREATE POLICY annotations_scope ON chart_annotations
  USING (owner_user_id = app_user_id()
         OR (firm_id = app_firm_id() AND (shared_scope = 'firm' OR (shared_scope = 'users' AND app_user_id() = ANY (shared_user_ids)))))
  WITH CHECK (owner_user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY saved_searches_owner ON saved_searches USING (owner_user_id = app_user_id()) WITH CHECK (owner_user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY alerts_owner         ON alerts         USING (owner_user_id = app_user_id()) WITH CHECK (owner_user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY alert_events_owner   ON alert_events   USING (EXISTS (SELECT 1 FROM alerts a WHERE a.alert_id = alert_events.alert_id))
                                                     WITH CHECK (firm_id = app_firm_id());
CREATE POLICY help_tickets_scope   ON help_tickets   USING (user_id = app_user_id() OR (firm_id = app_firm_id() AND app_role() IN ('admin','helpdesk')))
                                                     WITH CHECK (user_id = app_user_id() AND firm_id = app_firm_id());
-- Messaging: members read; compliance/supervisors of a member's firm read for review (MSG-02); the newsroom role never has a firm context (SEC-06).
-- A policy on room_members cannot sub-select room_members (Postgres raises "infinite recursion detected in policy"), so
-- membership is answered by SECURITY DEFINER helpers owned by the migration owner, which bypass the (non-FORCEd) policy.
CREATE FUNCTION is_room_member(p_room_id bigint, p_user_id bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = p_room_id AND m.user_id = p_user_id AND m.left_at IS NULL) $$;
CREATE FUNCTION room_has_firm(p_room_id bigint, p_firm_id bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM room_members m JOIN users u ON u.user_id = m.user_id WHERE m.room_id = p_room_id AND u.firm_id = p_firm_id) $$;
REVOKE ALL ON FUNCTION is_room_member(bigint, bigint), room_has_firm(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_room_member(bigint, bigint), room_has_firm(bigint, bigint) TO terminal_app;

CREATE POLICY rooms_member ON rooms
  USING (is_room_member(rooms.room_id, app_user_id())
         OR (app_role() = 'compliance' AND room_has_firm(rooms.room_id, app_firm_id())))
  WITH CHECK (created_by = app_user_id());
CREATE POLICY room_members_visible ON room_members
  USING (user_id = app_user_id()
         OR is_room_member(room_members.room_id, app_user_id())
         OR (app_role() = 'compliance' AND room_has_firm(room_members.room_id, app_firm_id())))
  WITH CHECK (app_user_id() IS NOT NULL);
CREATE POLICY messages_member ON messages
  USING (is_room_member(messages.room_id, app_user_id())
         OR (app_role() = 'compliance' AND room_has_firm(messages.room_id, app_firm_id())))
  WITH CHECK (sender_user_id = app_user_id() AND sender_firm_id = app_firm_id() AND is_room_member(messages.room_id, app_user_id()));
CREATE POLICY message_reads_owner ON message_reads USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY legal_holds_firm    ON legal_holds    USING (firm_id = app_firm_id() AND app_role() IN ('compliance','admin')) WITH CHECK (firm_id = app_firm_id() AND app_role() IN ('compliance','admin'));
CREATE POLICY surveillance_hits_compliance ON surveillance_hits USING (app_role() = 'compliance') WITH CHECK (app_role() = 'compliance');
CREATE POLICY message_reviews_compliance   ON message_reviews   USING (app_role() = 'compliance') WITH CHECK (app_role() = 'compliance');

-- 15.g Surveillance and hash-chain writers run inside the sender's transaction (messaging/service.ts), so no policy bypass is needed.
```

### 15.1 `packages/server/src/db/client.ts`

```ts
export interface RequestCtx { userId: number; firmId: number; role: 'user'|'admin'|'compliance'|'dataops'|'helpdesk'|'newsroom'; sessionId: string }
/** Every request handler and every function resolver runs inside withTx. Ingest jobs call withTx(null, fn): no app.* settings → tenant policies yield zero rows. */
export async function withTx<T>(ctx: RequestCtx | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (ctx && ctx.role !== 'newsroom') {                       // SEC-06: the newsroom role never receives a firm context
      await tx.execute(sql`SELECT set_config('app.user_id', ${String(ctx.userId)}, true),
                                  set_config('app.firm_id', ${String(ctx.firmId)}, true),
                                  set_config('app.role', ${ctx.role}, true)`);
    } else if (ctx) {
      await tx.execute(sql`SELECT set_config('app.user_id', ${String(ctx.userId)}, true), set_config('app.role', 'newsroom', true)`);
    }
    return fn(tx);
  });
}
/** Partition maintenance only (§15.d.1). A second pool, max 1 connection, on DATABASE_URL_MAINT as `terminal_maint`,
 *  which owns the six partitioned parents. Nothing else in the process may use it: no RequestCtx is ever set on it,
 *  so every tenant policy yields zero rows there. */
export async function withMaintTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
```

`server/test/integration/tenant-isolation.test.ts` connects as `terminal_app`, seeds two firms, reads
`portfolios`, `positions`, `messages` and `watchlists` as the other firm's user and expects zero rows
and a rejected insert; it also clears `app.firm_id` and expects zero rows from every tenant table.
`FORCE ROW LEVEL SECURITY` extends the policies to the table owner, but **superusers always bypass
RLS**: the local dev owner is a superuser, which is why the server must never connect as the owner and
why the migration owner in shared environments is a non-superuser role with `CREATEROLE` only.
`server/test/integration/worm.test.ts` asserts `UPDATE messages` and `DELETE FROM access_log` raise
both as `terminal_app` (permission denied) and as the owner (trigger), and that the chain verifies.

---

## 16. Migration 0016 — initial partitions (generated)

`scripts`-free: the migration is produced by `db/partitions.ts#renderInitialPartitions()` for the seed
window and committed. Content (abridged to one line per family; the file lists every partition):

```sql
-- migration: 0016_partitions_initial.sql
CREATE TABLE bars_daily_pre2000 PARTITION OF bars_daily FOR VALUES FROM (MINVALUE) TO ('2000-01-01');
CREATE TABLE bars_daily_y2000 PARTITION OF bars_daily FOR VALUES FROM ('2000-01-01') TO ('2001-01-01');
CREATE TABLE bars_daily_y2001 PARTITION OF bars_daily FOR VALUES FROM ('2001-01-01') TO ('2002-01-01');
CREATE TABLE bars_daily_y2002 PARTITION OF bars_daily FOR VALUES FROM ('2002-01-01') TO ('2003-01-01');
CREATE TABLE bars_daily_y2003 PARTITION OF bars_daily FOR VALUES FROM ('2003-01-01') TO ('2004-01-01');
CREATE TABLE bars_daily_y2004 PARTITION OF bars_daily FOR VALUES FROM ('2004-01-01') TO ('2005-01-01');
CREATE TABLE bars_daily_y2005 PARTITION OF bars_daily FOR VALUES FROM ('2005-01-01') TO ('2006-01-01');
CREATE TABLE bars_daily_y2006 PARTITION OF bars_daily FOR VALUES FROM ('2006-01-01') TO ('2007-01-01');
CREATE TABLE bars_daily_y2007 PARTITION OF bars_daily FOR VALUES FROM ('2007-01-01') TO ('2008-01-01');
CREATE TABLE bars_daily_y2008 PARTITION OF bars_daily FOR VALUES FROM ('2008-01-01') TO ('2009-01-01');
CREATE TABLE bars_daily_y2009 PARTITION OF bars_daily FOR VALUES FROM ('2009-01-01') TO ('2010-01-01');
CREATE TABLE bars_daily_y2010 PARTITION OF bars_daily FOR VALUES FROM ('2010-01-01') TO ('2011-01-01');
CREATE TABLE bars_daily_y2011 PARTITION OF bars_daily FOR VALUES FROM ('2011-01-01') TO ('2012-01-01');
CREATE TABLE bars_daily_y2012 PARTITION OF bars_daily FOR VALUES FROM ('2012-01-01') TO ('2013-01-01');
CREATE TABLE bars_daily_y2013 PARTITION OF bars_daily FOR VALUES FROM ('2013-01-01') TO ('2014-01-01');
CREATE TABLE bars_daily_y2014 PARTITION OF bars_daily FOR VALUES FROM ('2014-01-01') TO ('2015-01-01');
CREATE TABLE bars_daily_y2015 PARTITION OF bars_daily FOR VALUES FROM ('2015-01-01') TO ('2016-01-01');
CREATE TABLE bars_daily_y2016 PARTITION OF bars_daily FOR VALUES FROM ('2016-01-01') TO ('2017-01-01');
CREATE TABLE bars_daily_y2017 PARTITION OF bars_daily FOR VALUES FROM ('2017-01-01') TO ('2018-01-01');
CREATE TABLE bars_daily_y2018 PARTITION OF bars_daily FOR VALUES FROM ('2018-01-01') TO ('2019-01-01');
CREATE TABLE bars_daily_y2019 PARTITION OF bars_daily FOR VALUES FROM ('2019-01-01') TO ('2020-01-01');
CREATE TABLE bars_daily_y2020 PARTITION OF bars_daily FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');
CREATE TABLE bars_daily_y2021 PARTITION OF bars_daily FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');
CREATE TABLE bars_daily_y2022 PARTITION OF bars_daily FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');
CREATE TABLE bars_daily_y2023 PARTITION OF bars_daily FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');
CREATE TABLE bars_daily_y2024 PARTITION OF bars_daily FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE bars_daily_y2025 PARTITION OF bars_daily FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE bars_daily_y2026 PARTITION OF bars_daily FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE bars_daily_y2027 PARTITION OF bars_daily FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
CREATE TABLE bars_intraday_m2026_08 PARTITION OF bars_intraday FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE bars_intraday_m2026_09 PARTITION OF bars_intraday FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE bars_intraday_m2026_10 PARTITION OF bars_intraday FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE bars_intraday_m2026_11 PARTITION OF bars_intraday FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE quote_ticks_d2026_09_14 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-14') TO ('2026-09-15');
CREATE TABLE quote_ticks_d2026_09_15 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-15') TO ('2026-09-16');
CREATE TABLE quote_ticks_d2026_09_16 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-16') TO ('2026-09-17');
CREATE TABLE quote_ticks_d2026_09_17 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-17') TO ('2026-09-18');
CREATE TABLE quote_ticks_d2026_09_18 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-18') TO ('2026-09-19');
CREATE TABLE quote_ticks_d2026_09_19 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-19') TO ('2026-09-20');
CREATE TABLE quote_ticks_d2026_09_20 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-20') TO ('2026-09-21');
CREATE TABLE quote_ticks_d2026_09_21 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-21') TO ('2026-09-22');
CREATE TABLE option_quotes_d2026_09_15 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-15') TO ('2026-09-16');
CREATE TABLE option_quotes_d2026_09_16 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-16') TO ('2026-09-17');
CREATE TABLE option_quotes_d2026_09_17 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-17') TO ('2026-09-18');
CREATE TABLE option_quotes_d2026_09_18 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-18') TO ('2026-09-19');
CREATE TABLE option_quotes_d2026_09_19 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-19') TO ('2026-09-20');
CREATE TABLE option_quotes_d2026_09_20 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-20') TO ('2026-09-21');
CREATE TABLE option_quotes_d2026_09_21 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-21') TO ('2026-09-22');
CREATE TABLE access_log_m2026_09 PARTITION OF access_log FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE access_log_m2026_10 PARTITION OF access_log FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE access_log_m2026_11 PARTITION OF access_log FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE usage_events_m2026_09 PARTITION OF usage_events FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE usage_events_m2026_10 PARTITION OF usage_events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE usage_events_m2026_11 PARTITION OF usage_events FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
```

Timestamp range bounds on `timestamptz` partitions are interpreted in the session time zone; the
migrator runs with `SET TIME ZONE 'UTC'` (set in `db/client.ts` for every connection), so a daily
partition is a UTC day. `partitionMaintenance.ts` (daily 01:00 ET) and startup (`ensurePartitions` for
every plan) keep the horizon ahead; a test (`server/test/integration/partitions.test.ts`) inserts a row
dated in the default partition and asserts `ensurePartitions` moves it and `dq_events` flagged it.

---

## 17. Index summary — hot paths and the index that serves each (NFR table)

| Path (owner function / module) | Index | Expected rows / notes |
| --- | --- | --- |
| Resolve `AAPL US Equity` (every launch; `refdata/resolve.ts`) | `instruments_ticker_idx (upper(ticker), exch_code, market_sector)` partial current | 1 |
| Resolve `/isin/…`, `/figi/…`, `/cusip/…`, OCC, CIK | `identifiers_lookup_idx (scheme, value)` partial current | 1 |
| Instrument → md lines (plant subjects, hotset) | `md_lines_instrument_idx`; `md_lines_symbol_idx (source_id, provider_symbol)` for normaliser lookups | 1–3 |
| Autocomplete server fallback (name ≥ 3 chars) | `instruments_name_trgm`, `issuers_name_trgm`, `people_name_trgm`, `econ_series_name_trgm`, `identifiers_value_trgm` | `similarity() > 0.3`, LIMIT 12 |
| HP / GP 1 y daily (< 200 ms p95) | `bars_daily` PK `(instrument_id, session_date)` + yearly partition pruning | ≈ 252 |
| GIP / b1m intraday | `bars_intraday` PK `(instrument_id, bar_interval, bar_ts)` + monthly pruning | ≈ 390 per day |
| Q / QM one session of ticks (< 2 s) | `quote_ticks_instrument_idx (instrument_id, capture_ts DESC)` + daily partition | ≈ 5,800 |
| OMON chain | `option_terms_chain_idx (underlying, expiry, strike, put_call)` + `option_quotes_underlying_idx` (DISTINCT ON latest capture) | 3,510 |
| EQS / WEI cross-section | `bars_daily_date_idx (session_date, instrument_id)`, `xbrl_frames` PK `(taxonomy, concept, unit, frame, cik)` | 500–6,300 |
| FA / EE point-in-time | `xbrl_facts_pit_idx (cik, taxonomy, concept, unit, period_end DESC, filed_at DESC)`; `fin_statements_pit_idx` | ≤ 60 per concept |
| CN / TOP / N / `n:*` subjects | `news_entity_links_entity_idx`, `news_items_published_idx`, `news_items_feed_idx`, `news_items_tsv_idx` (GIN), `news_items_headline_trgm` | page of 50 |
| CACS / adjust-on-read | `corporate_actions_inst_ex_idx (instrument_id, ex_date)` partial current | ≤ 200 |
| MEMB as-of | `index_members_asof_idx (index_id, valid_from, valid_to)` partial current | ≈ 503 |
| ECO | `econ_release_events_time_idx (scheduled_at)` | week window |
| Econ PIT / `e:*` | `econ_observations_latest_uniq (series_id, obs_date) WHERE is_latest`; `econ_observations_pit_idx` | 1 per date |
| Rates `r:*` | `rate_fixings_latest_uniq (rate_code, effective_date) WHERE is_latest` | 1 |
| Curves `c:*` / CRVF | `curve_points_date_idx (curve_id, curve_date DESC) WHERE is_latest`; `curve_builds` unique on inputs hash | ≈ 14 per date |
| Entitlement evaluation | `entitlement_grants_subject_idx (subject_kind, subject_id) WHERE valid_to = 'infinity'`; `field_licence` PK; `licence_registry_current_idx` | cached 60 s |
| Session check (every request) | `sessions.token_hash` unique; `sessions_one_active_web` | 1 |
| Declarations (monthly) | `access_log_declare_idx (source_id, field_class, tier, usage, ts)` + monthly partition | one partition |
| Trace query (OPS-07) | `*_trace_idx` on `provenance`, `access_log`, `usage_events` | tens |
| Alerts on plant deltas | `alerts_armed_price_idx (instrument_id) WHERE status='armed' AND kind='price'` | in-memory mirror, reloaded on change |
| Watchlist hot set | `watchlist_items_instrument_idx` | connected users only |
| DQ dashboard / status | `dq_events_open_idx (kind, ts DESC) WHERE resolved_at IS NULL` | open events |

Every bitemporal table also has `<table>_current_idx (<key>) WHERE tx_to = 'infinity'`; the GiST
exclusion index doubles as the range index for `bt_as_of` scans on `(key, valid range)`.

---

## 18. Seed strategy and volumes (`packages/server/src/seed/*`, offline from the replay store)

`npm run db:seed` runs as the owner, is deterministic and idempotent (`upsertVersion` no-ops on
identical data; time-series upsert on natural keys), reads only `fixtures/providers/raw/*` through the
replay store (so every seeded value has a `provenance` row pointing at a fixture) and
`fixtures/seed/*.json`. Order = module order below; each module is one transaction.

| # | Module | Fixture(s) | Tables | Rows (offline seed) |
| --- | --- | --- | --- | --- |
| 1 | `seed/licences.ts` | `providers/licences.ts` | `licence_registry` (33 sources), `field_licence` | 33; ≈ 420 field×class rows |
| 2 | `seed/universe.ts` — calendars & exchanges | `core/calendars` rule generators | `calendars` (9), `calendar_sessions`, `calendar_holidays` 1990–2040, `exchanges` (14: XNYS, XNAS, ARCX, BATS, XCBO, XCBF, XLON, XETR, XPAR, XAMS, XSWX, XTKS, XHKG, XASX) | ≈ 1,300 holidays |
| 3 | `seed/universe.ts` — US listed universe | `cboe-symbol-book.json` (35,618), `sec-company-tickers.json` (10,422), `openfigi-map`/`openfigi-search` (AAPL 275 venues) | `issuers` ≈ 10.5k (CIK), `issues`/`instruments` ≈ 35.6k (equity ≈ 30k, etf ≈ 4k, future-shaped Cboe roots ≈ 1.6k `status='pending'`), `listings` (AAPL 275 + one composite listing per S&P name ≈ 780), `md_lines` ≈ 36k (`cboe.quotes`) + 503 (`yahoo.chart`), `identifiers` ≈ 90k | search snapshot ≈ 36k instruments |
| 4 | `seed/universe.ts` — S&P 500 | `sec-nport-SPY-primary_doc.xml` (504 holdings, `repPdDate 2026-06-30`), `ssga-spy-holdings.xlsx` (2026-09-14), `wiki-sp500.html` (GICS, CIK) | `indices` (SPX + 30 WEI indices), `index_members` (503 × 2 as-of dates), `etf_holdings` 504 + 503, `entity_classifications` GICS 503, `classification_codes` GICS ≈ 180 + SIC ≈ 440, `fund_terms` (SPY), `index_terms` (31), `entity_relations` (SPY holds 503; SPY tracks SPX) | ≈ 1,010 memberships |
| 5 | `seed/universe.ts` — indices, FX, crypto | `yahoo-chart-SPX-5d-5m.json`, `yahoo-ftse`, `yahoo-fx`, `cboe-spx`, `cboe-vix`, `cboe-eu-indices`, `coingecko-simple.json` | 31 index instruments (`^GSPC ^DJI ^IXIC ^NDX ^RUT ^VIX ^GSPTSE ^MXX ^BVSP ^FTSE ^GDAXI ^FCHI ^STOXX50E ^IBEX FTSEMIB.MI ^AEX ^SSMI ^OMX ^N225 ^HSI 000001.SS ^STI ^AXJO ^BSESN ^KS11 ^TWII ^JKSE ^NZ50 ^TA125.TA ^J203.JO BUK100P`), 9 G10 pairs (`EURUSD GBPUSD USDJPY USDCHF USDCAD AUDUSD NZDUSD USDSEK USDNOK` → Yahoo `EURUSD=X`, `JPY=X` …) with `fx_terms`, 4 crypto (`BTC ETH SOL XRP` → coingecko ids; quotes recorded for BTC/ETH) | 44 instruments, ≈ 60 md lines |
| 6 | `seed/rates.ts` — Treasuries & rates | `treasury-bills.xml` (7 bills: `912797VE4 912797UK1 912797VN4 912797VA2 912797WH6 912797WD5 912797WA1` with maturities), `fixtures/seed/treasuries.json` (7 on-the-run notes/bonds 2/3/5/7/10/20/30Y, curated CUSIP/coupon/dated/maturity), `nyfed-all`, `nyfed-effr.json`, `nyfed-sofr`, `fed-h15.csv` | 14 govt instruments + `govt_terms` (14), 6 rate instruments + `rate_terms`, `rate_fixings` ≈ 30, `econ_series` for 6 rates + 11 H.15 CMT, `econ_observations` ≈ 100 | 20 instruments |
| 7 | `seed/curves.ts` | `treasury-xml2` (9 days par 1M–30Y), `treasury-bills.xml` (9 days × 7 tenors × 2 quote types), `fed-h15.csv` (5 days × 11), `nyfed-sofr` | `curves` (5), `curve_points` ≈ 300, `curve_builds` (SOFR_OIS for the latest date) | ≈ 300 |
| 8 | `seed/bars.ts` | `yahoo-chart-events` (AAPL 1,255 daily 5y + 20 dividends), `yahoo-chart-AAPL-max-1d.json` (169 quarterly rows + 2 splits), `yahoo-chart-AAPL-1d-1m.json` (317), `yahoo-chart-1m`, `yahoo-chart-SPX-5d-5m.json` (377), `yahoo-fx` (238), `yahoo-ftse` (103), `yahoo-bond` (75), `frankfurter` (29 rates) | `bars_daily` ≈ 1,450, `bars_intraday` ≈ 1,110, `fx_rates` 29, `corporate_actions` (AAPL 20 dividends + splits 2014-06-09 7:1, 2020-08-31 4:1, + 2 historical 2:1) ≈ 24 | offline ≈ 2.6k; live backfill 10 y × 550 names ≈ 1.4M |
| 9 | `seed/bars.ts` — options & quotes | `cboe-options` (3,510 AAPL contracts), `cboe-quote-AAPL.json`, `cboe-spx`, `cboe-vix`, `cboe-eu-indices` | option instruments 3,510 + `option_terms` 3,510 + `option_quotes` 3,510; `quote_ticks` 4; `quote_snapshots` 4 (plant warm start); `eod_snapshots` 4 | ≈ 10.5k |
| 10 | `seed/fundamentals.ts` | `sec-companyfacts-AAPL.json` (503 us-gaap + 2 dei concepts ≈ 40k facts), `sec-submissions-AAPL.json` (1,000 filings), `sec-spy-submissions.json` (275), `sec-frames-assets.json` (6,264 Assets CY2024Q4I), `fixtures/seed/concept-map.json` | `xbrl_facts` ≈ 40k, `filings` 1,275, `xbrl_frames` 6,264, `xbrl_concept_map` ≈ 90, `fin_statements` 617 (AAPL Q/FY/TTM: 72 FY, 285 Q, 260 TTM — one row per (period, filing), not per period, because a statement is point-in-time and a restated period exists once per filing; the earlier ≈120 counted periods), `issuer_aliases` (SEC formerNames), `short_interest` 1 (`finra-trace`) | ≈ 48k |
| 11 | `seed/news.ts` | `bbg-rss-{markets,econ,politics,tech,industries}` (5 × 20), `sec-8k-atom.xml` (40), `fed-press-rss.xml` (20), `bls-cpi.json`, `worldbank`, `imf-weo.json`, `fred-DGS10.csv` (16,881), `fred-cal`, `fred-releases.html`, `bls-schedule.html`, `fixtures/seed/fomc-2026.json` | `topics` 13, `news_items` 160, `news_entity_links` ≈ 200, `people` (authors ≈ 60), `econ_series` ≈ 70, `econ_observations` ≈ 17k, `econ_releases` ≈ 40, `econ_release_events` ≈ 60, `fomc_meetings` 8 | ≈ 17.6k |
| 12 | `seed/users.ts` | `fixtures/seed/firms.json`, `users.json`, `entitlements.json` | `firms` 2 (`Demo Capital` 5 seats, `Other Desk` for isolation tests), `users` 7 (`pm@demo`, `analyst@demo`, `rates@demo`, `compliance@demo`, `dataops@demo`, `eod@demo`, `reporter@newsco` role `newsroom`), `user_credentials` (password each; WebAuthn registered at first login), `entitlement_grants` 8, `quota_limits` 2, `surveillance_lexicon` 12, `rooms` 2, `room_members`, `messages` 6 | tiny |
| 13 | `seed/workspaces.ts` | `fixtures/seed/workspaces.json` | `workspaces` (default 4-panel: WEI / TOP / GP SPX / W "Core" per user), `watchlists` ("MAG7", "S&P 500 Top 25", "Core"), `portfolios` ("Demo Long", 12 lots, `positions`) | 7 workspaces |

Production-style growth on a single Postgres 14 (`shared_buffers = 2 GB`, `work_mem = 64 MB`):
`quote_ticks` ≈ 0.7–0.9 M rows/day for a 100-name hot set at a 10 s poll (30-day retention ≈ 25 M rows,
≈ 3 GB); `bars_intraday` ≈ 120 k rows/day; `bars_daily` + 1.5 k/day; `option_quotes` 3.5 k per polled
underlying per minute while subscribed (10-day retention); `access_log` ≈ 50 rows per function launch,
≈ 200 k/day for 50 users (≈ 6 M rows/month per partition); `xbrl_facts` ≈ 40–50 k per issuer, fetched
lazily on first FA/EE and refreshed daily, ≈ 25 M for the S&P 500.

---

## 19. Personal data and lawful basis (REG-04)

| Table.column | Data | Lawful basis | Retention / erasure |
| --- | --- | --- | --- |
| `users.email`, `display_name` | identity of a contracted user | contract (service provision), legal obligation (ENTL-03 natural-person licensing) | anonymised to `user-<id>` on `DELETE /api/v1/admin/users/:id` (`anonymised_at`); row kept for audit-log referential integrity |
| `users.desk`, `role`, `person_verified_at`, `verified_by` | onboarding evidence (SEC-01) | legal obligation | as above |
| `users.sanctions_screened_at`, `sanctions_status` | screening result (REG-06) | legal obligation | as above |
| `user_credentials.*` | WebAuthn public key, password hash | contract | deleted on deprovisioning |
| `sessions.ip`, `user_agent`, `device_id` | connection metadata (SEC-03) | legitimate interest (fraud / licence-sharing detection) | 90 days after `revoked_at` (retentionPurge) |
| `access_log.user_id`, `usage_events.user_id` | pseudonymous usage (ENTL-04, FUNC-04) | legal obligation (vendor audit), legitimate interest (product analytics) | 7 years / 2 years; never deleted on erasure (legal obligation) |
| `messages.body`, `attachments` | communications (MSG-02) | legal obligation (SEC 17a-4 / FINRA 3110) | ≥ 7 years, WORM; erasure requests refused with reason |
| `people.name`, `role`, `aliases` | public officers from SEC filings, published news authors | legitimate interest (public-source reference data) | bitemporal close on request |
| `help_tickets.question`, `screen_state` | support content | contract | 2 years |
| `positions.*`, `lots.*`, `portfolios.*` | client holdings (PORT-07) — not personal data, but confidential | contract | deleted on request by the owning firm; RLS-isolated |

---

## 20. Decision log (where the candidates disagreed or were wrong for Postgres 14)

| Topic | Chosen | Why (one line) |
| --- | --- | --- |
| Bitemporal representation | four `timestamptz` columns (A, C) not two `tstzrange` columns (B) | Drizzle maps plain columns without a custom type; `bt_as_of()` is inlinable; ranges are built inside the exclusion constraint only. |
| Exclusion scope | current-version-only (`WHERE tx_to = 'infinity'`) + guard trigger (A) not double-range exclusion (C) | Closed transaction versions legitimately overlap in valid time — that is what a correction is (ARCHITECTURE §15). |
| Guard trigger | jsonb diff `to_jsonb(NEW) - 'tx_to'` (B's technique on A's columns) | Compares every column without listing them; survives column additions. |
| Ids on partitioned tables | explicit sequences (`nextval`) | PG 14 rejects `GENERATED … AS IDENTITY` on partitioned tables; A, B and C all had that bug. |
| Unique natural key of `xbrl_facts` | unique index over `COALESCE(period_start, '0001-01-01')` | `period_start` is NULL for instant facts; a `UNIQUE` constraint treats NULLs as distinct and would allow duplicates. |
| RLS setting access | `app_user_id()` / `app_firm_id()` helper functions with `NULLIF(…, '')` | `current_setting(name, true)` returns `''` after a `SET LOCAL` scope ends and `''::bigint` raises; a helper makes every policy uniform. |
| Default partitions | present on every partitioned table (B, C) with a DQ alarm and a move-then-attach procedure | Prevents insert failures at the horizon without letting rows hide there. |
| Generated `tsvector` | `STORED` generated column with two-argument `to_tsvector` (A, B, C) | Legal in PG 12+; the regconfig-argument form is IMMUTABLE as required. |
| Message chain | trigger assigns `seq`, `prev_hash`, `hash` under `pg_advisory_xact_lock` per room (B's seq + C's lock idea) | Two concurrent sends in one room cannot fork the chain; a rule-based `DO INSTEAD NOTHING` (B) silently swallows writes, so WORM uses triggers + REVOKE. |
| Rates storage | headline in `econ_observations`, full record in `rate_fixings` (C) | QuoteFields `RATE_P1…RATE_VOLUME_BN` need typed columns; econ series stay uniform for `e:` subjects and GP. |
| Curve points | `(curve_id, curve_date, tenor, quote_type, vintage_at)` with `is_latest` | Bills publish two quote types per tenor; Treasury restatements exist; `is_latest` keeps the hot read a single index probe. |
| Daily bars key | `(instrument_id, session_date)` with `md_line_id` as a column (B, C) not in the key (A) | One truth row per day; cross-source reconciliation reads `eod_snapshots` vs `bars_daily`. |
| Cash-dividend adjustment | only under `total_return`; `price` = capital-structure events only | BRIEF fixes three policies (`unadjusted | price | total_return`); a fourth `split_dividend` (A, C) is not in the contract. |
| Index membership | bitemporal `index_members` keyed `(index_id, instrument_id)` (A, C) with `as_of_date` column (B) | MEMB as-of is one `bt_as_of` predicate; B's per-`as_of` rows double the row count without adding a query. |
| Terms tables | one table per asset class (A) with C's full REF-04 column set on `govt_terms` | A `debt_terms` superset (C) is unused in the wedge; REF-04 columns are kept so a corporate bond needs no migration. |
| Licence registry key | versioned `source_id` + trigger `assert_source_known()` | A true FK to a versioned table is impossible; the trigger gives the same guarantee at insert time. |
| Entitlement grants | non-bitemporal `valid_from/valid_to` rows (A, C) | Grants are audited through `access_log` and version-bumped; full bitemporality (B) adds nothing the audit needs. |
| Session invariant | partial unique index `sessions_one_active_web` | Makes SEC-03 a database constraint, not application logic. |
| Role creation | `DO` block with `pg_roles` check, database grant via `current_database()` | Roles are cluster-wide and dev/test share one cluster; a bare `CREATE ROLE` fails on the second database. |
| Room-membership policies | `SECURITY DEFINER` helpers `is_room_member()` / `room_has_firm()` (none of A, B, C) | A policy that sub-selects its own table raises "infinite recursion detected in policy" on PG 14 (found by the scratch-DB run); B's and C's `messages` policies would have worked only because they never policed `room_members`. |
| Superuser and RLS | server never connects as the owner; isolation test runs as `terminal_app` | Superusers bypass RLS even under `FORCE`; the local dev owner is a superuser, so an owner-connected server would silently disable PORT-07. |
| FK from partitioned tables | kept (`provenance_id`) | Legal since PG 11; DATA-10 outweighs the per-insert lookup. |
| pgvector | not available; `news_items` full-text only | STOR-04 vector search is recorded as a gap in TRACEABILITY.md. |

---

## 21. Drizzle mirror and migration mechanics (`packages/server/src/db/schema/*.ts`, `drizzle.config.ts`)

- Enums: `pgEnum('asset_class', [...])` etc. in `schema/enums.ts`, names identical to §1.
- Bitemporal tables: `bigserial('version_id').primaryKey()`, entity id `bigint('instrument_id', { mode: 'number' }).notNull().default(sql\`nextval('instrument_id_seq')\`)`, the five `[BT]` columns via a shared `bitemporalColumns()` helper in `db/bitemporal.ts`; exclusion constraints, partial indexes and triggers are **not** declared in Drizzle (they live only in SQL) — `drizzle-kit check` is run in "no-diff" mode against `information_schema` by `schema.mirror.test.ts`.
- Partitioned tables: declared as ordinary `pgTable`s (columns + composite PK); partitions are invisible to Drizzle.
- `numeric` columns use `numeric('close', { precision: 18, scale: 6 })` and are read as strings; `core/fields/format.ts` parses once at the API boundary (API-05).
- Generated `tsv`, `jsonb` states and `bytea` hashes: `customType` where Drizzle lacks a native (`bytea`), `.generatedAlwaysAs()` for `tsv`.
- Migrations: `drizzle-kit generate --custom --name <name>` creates the numbered SQL file and journal entry; the SQL from this document is pasted verbatim; `npm run db:migrate` runs `migrate(db, { migrationsFolder: './drizzle/migrations' })` as the owner with `SET TIME ZONE 'UTC'`. Drizzle splits statements on its `--> statement-breakpoint` marker; every `$$`-quoted function body is one statement and must not contain the marker.
- Test DB: `npm test` runs migrations 0001–0016 against `bloomberg_test` inside `test/db.ts` (`TRUNCATE … RESTART IDENTITY CASCADE` between suites, excluding `licence_registry`, `field_licence`, `calendars*`, `config_versions`).

### 21.1 Open questions (not resolvable from the inputs)

1. Cboe `symbol-book.json` mixes equities, ETFs and Cboe futures/index roots with no type field; the seed classifies by SEC-ticker join and root patterns. A definitive `asset_class` for the ≈ 1,600 unmatched symbols needs a second symbology pass (OpenFIGI mapping at 25 req/min ≈ 4 h) — recorded as `data_exceptions kind='unresolved_identifier'`.
2. On-the-run note/bond CUSIPs, coupons and dated dates are not in any recorded fixture (only bills are); `fixtures/seed/treasuries.json` must be curated by hand until a Treasury auction-results adapter exists.
3. SSGA's daily holdings file carries SEDOL and weight but the N-PORT carries CUSIP/ISIN/LEI; when the two disagree on a constituent between their as-of dates, `index_members` keeps both versions and MEMB shows the later `as_of_date` — whether to prefer the regulatory (N-PORT) source when both exist for the same date is a data-ops policy.
4. The SEC frames API gives no `filed` date, so `xbrl_frames.filed_at` is filled only when the matching `xbrl_facts` row exists; EQS backtests over frames are therefore point-in-time only for issuers whose companyfacts have been ingested.
