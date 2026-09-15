# DATA_MODEL — Postgres 14 DDL (Drizzle-compatible, committed SQL migrations)

All DDL below is the content of `packages/server/src/db/migrations/00NN_*.sql`, applied by
`npm run db:migrate` (Drizzle migrator). Drizzle schema files under `packages/server/src/db/schema/`
mirror the columns for typed queries; constraints Drizzle cannot express (exclusion, partitions,
RLS, triggers) live only in SQL. The application connects as role `terminal_app` (not the owner)
so row-level security and the WORM revokes apply.

Migration order: `0001_extensions_enums` → `0002_provenance_sources` → `0003_security_master` →
`0004_terms` → `0005_classifications_calendars` → `0006_market_data` → `0007_corporate_actions` →
`0008_fundamentals` → `0009_econ_curves_indices` → `0010_news` → `0011_users_entitlements` →
`0012_workspace_messaging_alerts` → `0013_ops` → `0014_rls_worm` → `0015_seed_static`.

---

## 0. Conventions

| Convention | Rule |
| --- | --- |
| Entity ids | `bigint` from a dedicated sequence per entity (`instrument_id_seq` …). Immutable for the life of the entity (REF-01). Never a ticker, never a FIGI (FIGIs can be reassigned on corporate events). |
| Version rows | Bitemporal tables have `version_id bigserial PRIMARY KEY` plus the entity id. A logical entity = the set of its version rows. |
| Time | All timestamps `timestamptz` in UTC. Dates that are calendar facts (session_date, ex_date, period_end) are `date`. |
| Numbers | Prices `numeric(18,6)`, rates/yields in **percent** `numeric(12,8)` (4.83 = 4.83 %), factors `numeric(20,12)`, money `numeric(28,6)`. Never `float` in stored market data. |
| Provenance | Every row that holds a sourced value has `provenance_id bigint NOT NULL REFERENCES provenance`. |
| Bitemporal marker | `-- [BT]` in a table body stands for exactly this block, expanded verbatim in the migration file: |

```sql
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  tx_from       timestamptz NOT NULL DEFAULT clock_timestamp(),
  tx_to         timestamptz NOT NULL DEFAULT 'infinity',
  provenance_id bigint      NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT <table>_valid_range CHECK (valid_from < valid_to),
  CONSTRAINT <table>_tx_range    CHECK (tx_from < tx_to),
```

Valid time = when the fact was true in the world. Transaction time = when *we* recorded it.
Rows are never updated in place except to close `tx_to` (see §1.3). Deletion is a closed `tx_to`.

---

## 1. Migration 0001 — extensions, enums, bitemporal machinery

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE asset_class    AS ENUM ('equity','etf','index','fx','govt','option','future','crypto','rate','econ');
CREATE TYPE market_sector  AS ENUM ('Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto');
CREATE TYPE id_scheme      AS ENUM ('FIGI','COMPOSITE_FIGI','SHARE_CLASS_FIGI','ISIN','CUSIP','SEDOL','RIC','TICKER_EXCH','LEI','MIC','CIK','OCC','PROVIDER_SYMBOL','SERIES_CODE');
CREATE TYPE ca_type        AS ENUM ('cash_dividend','special_dividend','stock_dividend','split','reverse_split','spinoff','merger','tender','rights','name_change','ticker_change','delisting','capital_return');
CREATE TYPE ca_status      AS ENUM ('estimated','announced','confirmed','paid','cancelled');
CREATE TYPE tier           AS ENUM ('realtime','delayed','eod');
CREATE TYPE usage_type     AS ENUM ('display','export','api');
CREATE TYPE field_class    AS ENUM ('price','reference','fundamental','econ','news','analytic','derived','portfolio');
CREATE TYPE entl_decision  AS ENUM ('allow','downgrade','deny');
CREATE TYPE tick_kind      AS ENUM ('trade','quote','summary');
CREATE TYPE entity_kind    AS ENUM ('issuer','issue','instrument','listing','person','topic');

-- 1.1 as-of predicate. IMMUTABLE so it can be used in partial indexes and is inlined by the planner.
CREATE FUNCTION bt_as_of(vf timestamptz, vt timestamptz, tf timestamptz, tt timestamptz,
                         valid_at timestamptz, known_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT vf <= valid_at AND vt > valid_at AND tf <= known_at AND tt > known_at
$$;

-- 1.2 Guard: application code must never UPDATE bitemporal rows except to close tx_to.
CREATE FUNCTION bt_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tx_to <> 'infinity' THEN RAISE EXCEPTION 'bitemporal row % already closed', OLD.version_id; END IF;
  IF NEW.tx_to = 'infinity' THEN RAISE EXCEPTION 'bitemporal rows are immutable; insert a new version'; END IF;
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) AND (
       NEW.valid_from <> OLD.valid_from OR NEW.valid_to <> OLD.valid_to OR NEW.tx_from <> OLD.tx_from
       OR NEW.provenance_id <> OLD.provenance_id) THEN
    RAISE EXCEPTION 'only tx_to may change on a bitemporal row';
  END IF;
  RETURN NEW;
END $$;
-- (DELETE is revoked from terminal_app on every bitemporal table in migration 0014.)
```

### 1.3 Write semantics — `packages/server/src/db/bitemporal.ts`

```ts
export interface AsOf { validAt: Date; knownAt: Date }
export const NOW: () => AsOf;                       // {validAt: clock.now(), knownAt: clock.now()}

/** SQL predicate for any table that spreads bitemporalColumns. */
export function asOf<T extends BitemporalTable>(t: T, at: AsOf): SQL {
  return sql`bt_as_of(${t.validFrom}, ${t.validTo}, ${t.txFrom}, ${t.txTo}, ${at.validAt}, ${at.knownAt})`;
}

export interface VersionWrite<Row> {
  entityKey: Partial<Row>;            // e.g. { instrumentId: 42 } or { scheme:'CUSIP', value:'…', qualifier:'' }
  validFrom: Date; validTo?: Date;    // default 'infinity'
  data: Omit<Row, BitemporalKeys | 'versionId'>;
  provenanceId: number;
  reason: 'change' | 'correction' | 'initial';   // audit label only; mechanics identical
}
/**
 * Atomic (must be called inside a transaction):
 * 1. Select current rows (tx_to='infinity') for entityKey whose valid range overlaps [validFrom, validTo).
 * 2. For each: set tx_to = now. Re-insert the non-overlapping remainders [old.valid_from, validFrom) and
 *    [validTo, old.valid_to) as new rows (tx_from = now, same data, same provenance) if non-empty.
 * 3. Insert the new row. The exclusion constraint proves no two current rows overlap.
 * Returns the new version_id. Never issues UPDATE on any column except tx_to.
 */
export async function writeVersion<Row>(tx: Tx, table: BitemporalTable<Row>, w: VersionWrite<Row>): Promise<number>;

/** No-op if the current version's data is identical (ingest idempotency); otherwise writeVersion. */
export async function upsertVersion<Row>(tx: Tx, table: BitemporalTable<Row>, w: VersionWrite<Row>): Promise<number | null>;
```

Worked example (REF-03 acceptance test, `packages/server/test/integration/bitemporal.spec.ts`):

```sql
-- 2026-03-01: we record the 10Y note 91282CJK8 with coupon 4.500 (provenance 1)
-- 2026-03-10: source correction: coupon was always 4.250 (provenance 2, reason='correction')
-- Q: "what did we believe the coupon was on 14 March, as of what we knew on 5 March?"  → 4.500
SELECT g.coupon_rate
FROM govt_terms g
JOIN identifiers i ON i.entity_kind='instrument' AND i.entity_id=g.instrument_id
                  AND i.scheme='CUSIP' AND i.value='91282CJK8'
WHERE bt_as_of(g.valid_from,g.valid_to,g.tx_from,g.tx_to, '2026-03-14', '2026-03-05T12:00Z')
  AND bt_as_of(i.valid_from,i.valid_to,i.tx_from,i.tx_to, '2026-03-14', '2026-03-05T12:00Z');
-- same query with known_at '2026-03-12' → 4.250
```

---

## 2. Migration 0002 — provenance and the licence registry

```sql
CREATE TABLE sources (                                  -- DATA-09 licence registry
  source_id              text PRIMARY KEY,               -- 'openfigi','cboe','yahoo','sec_edgar','sec_nport','fred','fed_h15','nyfed','ustreasury','bls','worldbank','imf','frankfurter','finra','bbg_rss','fed_rss','coingecko','stooq','wikipedia','ssga','internal'
  name                   text NOT NULL,
  publisher              text NOT NULL,
  url                    text NOT NULL,
  terms_url              text,
  licence_kind           text NOT NULL CHECK (licence_kind IN ('public_domain','open_data','exchange_delayed','unofficial','cc_by_sa','vendor_terms','internal')),
  display_allowed        boolean NOT NULL,
  export_allowed         boolean NOT NULL,
  api_allowed            boolean NOT NULL,
  redistribution_allowed boolean NOT NULL DEFAULT false,
  derived_allowed        boolean NOT NULL DEFAULT true,
  intrinsic_delay_min    int     NOT NULL DEFAULT 0,      -- best achievable tier bound (cboe = 15)
  retention_days         int,                             -- NULL = unlimited (STOR-07)
  attribution            text,
  rate_limit_per_min     int,
  daily_quota            int,                             -- bls = 25
  requires_user_agent    boolean NOT NULL DEFAULT false,  -- sec_edgar = true
  api_key_env            text,                            -- 'OPENFIGI_API_KEY'
  contract_ref           text,                            -- DATA-01: signed agreement reference (NULL for all v1 public sources)
  audit_obligation       text,
  notes                  text,
  valid_from             date NOT NULL DEFAULT current_date,
  valid_to               date
);

CREATE TABLE source_fields (                            -- which source supplies which field per asset class
  field_id     text        NOT NULL,                    -- SDK dictionary id, e.g. 'PX_LAST'
  asset_class  asset_class NOT NULL,
  source_id    text        NOT NULL REFERENCES sources(source_id),
  field_class  field_class NOT NULL,
  is_primary   boolean     NOT NULL DEFAULT true,
  PRIMARY KEY (field_id, asset_class, source_id)
);

CREATE TABLE provenance (                               -- DATA-10
  provenance_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id       text        NOT NULL REFERENCES sources(source_id),
  endpoint        text        NOT NULL,                 -- logical endpoint id, e.g. 'cboe.delayed_quote'
  request_key     text        NOT NULL,                 -- canonical replay key (PROVIDERS.md §2)
  response_sha256 char(64)    NOT NULL,
  raw_ref         text        NOT NULL,                 -- replay store path: fixtures/providers/<provider>/<hash>.json
  fetched_at      timestamptz NOT NULL,                 -- capture timestamp
  source_ts       timestamptz,                          -- provider-published timestamp if any
  http_status     smallint    NOT NULL,
  bytes           int         NOT NULL,
  trace_id        uuid,
  run_id          bigint,                               -- ingest_runs.run_id
  contract_ref    text                                  -- copied from sources at fetch time
);
CREATE INDEX provenance_source_fetched_idx ON provenance (source_id, fetched_at DESC);
CREATE INDEX provenance_request_key_idx    ON provenance (request_key, fetched_at DESC);
```

---

## 3. Migration 0003 — security master (issuer → issue → instrument → listing → md line) + identifiers

```sql
CREATE SEQUENCE issuer_id_seq; CREATE SEQUENCE issue_id_seq; CREATE SEQUENCE instrument_id_seq;
CREATE SEQUENCE listing_id_seq; CREATE SEQUENCE md_line_id_seq; CREATE SEQUENCE ca_id_seq;

CREATE TABLE issuers (
  version_id     bigserial PRIMARY KEY,
  issuer_id      bigint NOT NULL,
  name           text   NOT NULL,
  legal_name     text,
  lei            char(20),
  cik            char(10),
  country        char(2),
  state_of_inc   text,
  sic            char(4),
  entity_type    text NOT NULL DEFAULT 'operating' CHECK (entity_type IN ('operating','fund','sovereign','index_provider','central_bank','other')),
  fiscal_year_end char(4),                               -- 'MMDD' from SEC submissions.fiscalYearEnd ('0926')
  website        text,
  -- [BT]
  CONSTRAINT issuers_bt_excl EXCLUDE USING gist (issuer_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX issuers_current_idx ON issuers (issuer_id) WHERE tx_to = 'infinity';
CREATE INDEX issuers_lei_idx     ON issuers (lei)       WHERE tx_to = 'infinity';
CREATE INDEX issuers_cik_idx     ON issuers (cik)       WHERE tx_to = 'infinity';
CREATE INDEX issuers_name_trgm   ON issuers USING gin (name gin_trgm_ops) WHERE tx_to = 'infinity';
CREATE TRIGGER issuers_bt_guard BEFORE UPDATE ON issuers FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE issues (                                   -- a security / share class / fund share / bond
  version_id        bigserial PRIMARY KEY,
  issue_id          bigint      NOT NULL,
  issuer_id         bigint      NOT NULL,
  asset_class       asset_class NOT NULL,
  security_type     text        NOT NULL,               -- OpenFIGI securityType: 'Common Stock','ETP','REIT','Index','Spot','US GOVERNMENT','Equity Option' …
  security_type2    text,
  share_class_figi  char(12),
  isin              char(12),
  cusip             char(9),
  sedol             char(7),
  name              text        NOT NULL,
  currency          char(3)     NOT NULL,
  country_of_issue  char(2),
  -- [BT]
  CONSTRAINT issues_bt_excl EXCLUDE USING gist (issue_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX issues_current_idx ON issues (issue_id)  WHERE tx_to = 'infinity';
CREATE INDEX issues_issuer_idx  ON issues (issuer_id) WHERE tx_to = 'infinity';
CREATE INDEX issues_isin_idx    ON issues (isin)      WHERE tx_to = 'infinity';
CREATE INDEX issues_cusip_idx   ON issues (cusip)     WHERE tx_to = 'infinity';
CREATE TRIGGER issues_bt_guard BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE instruments (                              -- the thing a user names on the command line (composite level)
  version_id          bigserial PRIMARY KEY,
  instrument_id       bigint        NOT NULL,
  issue_id            bigint        NOT NULL,
  asset_class         asset_class   NOT NULL,
  market_sector       market_sector NOT NULL,
  composite_figi      char(12),
  ticker              text          NOT NULL,           -- 'AAPL', 'SPX', 'EURUSD', '912797VE4', 'SOFRRATE'
  exch_code           text          NOT NULL DEFAULT 'US', -- OpenFIGI composite code; 'US' composite, 'FX', 'GOVT', 'INDEX' …
  name                text          NOT NULL,
  currency            char(3)       NOT NULL,
  primary_listing_id  bigint,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','delisted','pending','matured','expired')),
  search_weight       real NOT NULL DEFAULT 1.0,        -- autocomplete prior (S&P 500 members, majors get > 1)
  -- [BT]
  CONSTRAINT instruments_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX instruments_current_idx ON instruments (instrument_id) WHERE tx_to = 'infinity';
CREATE INDEX instruments_ticker_idx  ON instruments (upper(ticker), market_sector) WHERE tx_to = 'infinity' AND valid_to = 'infinity';
CREATE INDEX instruments_figi_idx    ON instruments (composite_figi) WHERE tx_to = 'infinity';
CREATE INDEX instruments_name_trgm   ON instruments USING gin (name gin_trgm_ops) WHERE tx_to = 'infinity';
CREATE INDEX instruments_issue_idx   ON instruments (issue_id) WHERE tx_to = 'infinity';
CREATE TRIGGER instruments_bt_guard BEFORE UPDATE ON instruments FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE listings (                                 -- one instrument, many venues (OpenFIGI exchCode UN/UW/UA/UP/…)
  version_id     bigserial PRIMARY KEY,
  listing_id     bigint NOT NULL,
  instrument_id  bigint NOT NULL,
  figi           char(12),
  mic            char(4),                               -- 'XNAS','XNYS','ARCX','BATS','XCBO'
  exch_code      text NOT NULL,
  local_ticker   text NOT NULL,
  is_primary     boolean NOT NULL DEFAULT false,
  listing_status text NOT NULL DEFAULT 'active',
  -- [BT]
  CONSTRAINT listings_bt_excl EXCLUDE USING gist (listing_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX listings_current_idx    ON listings (listing_id)    WHERE tx_to = 'infinity';
CREATE INDEX listings_instrument_idx ON listings (instrument_id) WHERE tx_to = 'infinity';
CREATE TRIGGER listings_bt_guard BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE md_lines (                                 -- market-data line = (instrument|listing) × provider symbol
  version_id            bigserial PRIMARY KEY,
  md_line_id            bigint NOT NULL,
  instrument_id         bigint NOT NULL,
  listing_id            bigint,                         -- NULL = composite line
  source_id             text   NOT NULL REFERENCES sources(source_id),
  provider_symbol       text   NOT NULL,                -- cboe 'AAPL' | '_SPX'; yahoo 'AAPL' | '^GSPC' | 'EURUSD=X'; coingecko 'bitcoin'
  line_kind             text   NOT NULL CHECK (line_kind IN ('composite','venue','derived','reference')),
  intrinsic_delay_min   int    NOT NULL,                -- cboe 15, yahoo 15 (unknown → treat as 15), nyfed 0 (daily)
  expected_interval_ms  int    NOT NULL,                -- poll cadence used for staleness (10000 for cboe during session)
  priority              smallint NOT NULL DEFAULT 100,  -- lower wins ties in composite rules
  -- [BT]
  CONSTRAINT md_lines_bt_excl EXCLUDE USING gist (md_line_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity'),
  CONSTRAINT md_lines_symbol_excl EXCLUDE USING gist (source_id WITH =, provider_symbol WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX md_lines_instrument_idx ON md_lines (instrument_id) WHERE tx_to = 'infinity';
CREATE TRIGGER md_lines_bt_guard BEFORE UPDATE ON md_lines FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE identifiers (                              -- REF-01 cross-reference; tickers are reused across time, never across a valid range
  version_id   bigserial PRIMARY KEY,
  entity_kind  entity_kind NOT NULL,
  entity_id    bigint      NOT NULL,
  scheme       id_scheme   NOT NULL,
  value        text        NOT NULL,
  qualifier    text        NOT NULL DEFAULT '',         -- TICKER_EXCH: exch code ('US','UW'); PROVIDER_SYMBOL: source_id; SERIES_CODE: source_id
  is_primary   boolean     NOT NULL DEFAULT false,
  -- [BT]
  CONSTRAINT identifiers_bt_excl EXCLUDE USING gist (scheme WITH =, value WITH =, qualifier WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX identifiers_lookup_idx ON identifiers (scheme, value) WHERE tx_to = 'infinity';
CREATE INDEX identifiers_entity_idx ON identifiers (entity_kind, entity_id) WHERE tx_to = 'infinity';
CREATE INDEX identifiers_value_trgm ON identifiers USING gin (value gin_trgm_ops) WHERE tx_to = 'infinity';
CREATE TRIGGER identifiers_bt_guard BEFORE UPDATE ON identifiers FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

-- Convenience views (as of now/now) used by non-PIT screens. Backtest-facing repos never use these.
CREATE VIEW instruments_now AS SELECT * FROM instruments WHERE bt_as_of(valid_from,valid_to,tx_from,tx_to, now(), now());
CREATE VIEW issuers_now     AS SELECT * FROM issuers     WHERE bt_as_of(valid_from,valid_to,tx_from,tx_to, now(), now());
CREATE VIEW identifiers_now AS SELECT * FROM identifiers WHERE bt_as_of(valid_from,valid_to,tx_from,tx_to, now(), now());
CREATE VIEW md_lines_now    AS SELECT * FROM md_lines    WHERE bt_as_of(valid_from,valid_to,tx_from,tx_to, now(), now());
```

Mapping from OpenFIGI (fixture `openfigi-map`): job 2 returned 275 venue rows for AAPL sharing
`compositeFIGI=BBG000B9XRY4` and `shareClassFIGI=BBG001S5N8V8` → one `issue` (share class), one
`instrument` per `compositeFIGI` whose `exchCode` is a composite code (`US`), one `listing` per
venue FIGI (`UN`,`UW`,`UA`,`UP`,…). Non-US composites (`GR`,`LN`,`JP`…) become additional
instruments under the same issue with `market_sector='Equity'` and their own `exch_code`.

---

## 4. Migration 0004 — asset-class terms (REF-04, REF-05)

```sql
CREATE TABLE govt_terms (                               -- US Treasury bills/notes/bonds/TIPS/FRNs
  version_id          bigserial PRIMARY KEY,
  instrument_id       bigint  NOT NULL,
  security_type       text    NOT NULL CHECK (security_type IN ('bill','note','bond','tips','frn')),
  cusip               char(9) NOT NULL,
  term_label          text,                             -- '4WK','13WK','2Y','10Y','30Y'
  issue_date          date,
  dated_date          date,
  maturity_date       date    NOT NULL,
  coupon_rate         numeric(9,6),                     -- percent; NULL for bills
  coupon_freq         smallint NOT NULL DEFAULT 2,
  day_count           text    NOT NULL,                 -- 'ACT/ACT' (notes/bonds), 'ACT/360' (bills)
  first_coupon_date   date,
  business_day_conv   text    NOT NULL DEFAULT 'following',
  calendar_id         text    NOT NULL DEFAULT 'SIFMA',
  settlement_days     smallint NOT NULL DEFAULT 1,
  is_callable         boolean NOT NULL DEFAULT false,
  call_schedule       jsonb   NOT NULL DEFAULT '[]',    -- [{date, price}] (always empty for modern Treasuries; kept for REF-04 shape)
  put_schedule        jsonb   NOT NULL DEFAULT '[]',
  sink_schedule       jsonb   NOT NULL DEFAULT '[]',
  amortisation        jsonb   NOT NULL DEFAULT '[]',
  index_ratio_base    numeric(14,8),                    -- TIPS
  min_denomination    numeric(14,2) NOT NULL DEFAULT 100,
  amount_outstanding  numeric(28,2),
  on_the_run          boolean NOT NULL DEFAULT false,
  seniority           text NOT NULL DEFAULT 'sovereign',
  -- [BT]
  CONSTRAINT govt_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX govt_terms_maturity_idx ON govt_terms (maturity_date) WHERE tx_to = 'infinity';
CREATE TRIGGER govt_terms_bt_guard BEFORE UPDATE ON govt_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE option_terms (                             -- listed US equity options (Cboe chain)
  version_id               bigserial PRIMARY KEY,
  instrument_id            bigint NOT NULL,
  occ_symbol               char(21) NOT NULL,           -- 'AAPL260916C00245000' (root left-padded to 6 in OSI; Cboe omits padding → store Cboe form, derive OSI)
  root                     text NOT NULL,
  underlying_instrument_id bigint NOT NULL,
  expiry                   date NOT NULL,
  strike                   numeric(14,4) NOT NULL,
  put_call                 char(1) NOT NULL CHECK (put_call IN ('C','P')),
  exercise_style           text NOT NULL DEFAULT 'american',
  settlement               text NOT NULL DEFAULT 'physical',
  multiplier               int  NOT NULL DEFAULT 100,
  tick_size                numeric(8,4),
  is_weekly                boolean NOT NULL DEFAULT false,
  last_trade_date          date,
  -- [BT]
  CONSTRAINT option_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX option_terms_chain_idx ON option_terms (underlying_instrument_id, expiry, strike, put_call) WHERE tx_to = 'infinity';
CREATE TRIGGER option_terms_bt_guard BEFORE UPDATE ON option_terms FOR EACH ROW EXECUTE FUNCTION bt_guard_update();

CREATE TABLE future_terms (                             -- shape only in v1 (no futures source)
  version_id bigserial PRIMARY KEY, instrument_id bigint NOT NULL, root text NOT NULL,
  underlying_instrument_id bigint, expiry date NOT NULL, last_trade_date date, first_notice_date date,
  multiplier numeric(14,4) NOT NULL, tick_size numeric(10,6) NOT NULL, settlement text NOT NULL, roll_convention text,
  -- [BT]
  CONSTRAINT future_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);

CREATE TABLE fund_terms (                               -- ETFs
  version_id bigserial PRIMARY KEY, instrument_id bigint NOT NULL,
  fund_type text NOT NULL DEFAULT 'etf', tracked_index_instrument_id bigint, sponsor text, cik char(10),
  series_id text, expense_ratio numeric(8,6), inception_date date, distribution_freq text,
  -- [BT]
  CONSTRAINT fund_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);

CREATE TABLE index_terms (
  version_id bigserial PRIMARY KEY, instrument_id bigint NOT NULL,
  provider text NOT NULL, methodology text NOT NULL CHECK (methodology IN ('cap_weighted','float_cap_weighted','price_weighted','equal_weighted','other')),
  calc_currency char(3) NOT NULL, region text, base_date date, base_value numeric(14,4), constituent_count int,
  proxy_fund_instrument_id bigint,                      -- SPY for SPX (membership + intraday proxy)
  -- [BT]
  CONSTRAINT index_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);

CREATE TABLE fx_terms (
  version_id bigserial PRIMARY KEY, instrument_id bigint NOT NULL,
  base_ccy char(3) NOT NULL, quote_ccy char(3) NOT NULL, spot_lag smallint NOT NULL DEFAULT 2,
  calendar_id text NOT NULL DEFAULT 'FX_USD', pip_size numeric(10,8) NOT NULL DEFAULT 0.0001, quote_convention text NOT NULL DEFAULT 'base_per_quote',
  -- [BT]
  CONSTRAINT fx_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);

CREATE TABLE rate_terms (                               -- SOFR, EFFR, OBFR, TGCR, BGCR, SOFR averages/index
  version_id bigserial PRIMARY KEY, instrument_id bigint NOT NULL,
  rate_code text NOT NULL, publisher text NOT NULL, day_count text NOT NULL DEFAULT 'ACT/360',
  publication_time_et time, tenor_days int NOT NULL DEFAULT 1, compounding text NOT NULL DEFAULT 'simple',
  series_id bigint,                                     -- econ_series link (observations live there)
  -- [BT]
  CONSTRAINT rate_terms_bt_excl EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
```

---

## 5. Migration 0005 — classifications, calendars, entities (REF-06/07/08)

```sql
CREATE TABLE classification_schemes (scheme text PRIMARY KEY, name text NOT NULL, source_id text NOT NULL REFERENCES sources(source_id), levels smallint NOT NULL);
CREATE TABLE classification_codes (
  scheme text NOT NULL REFERENCES classification_schemes(scheme), code text NOT NULL, name text NOT NULL,
  parent_code text, level smallint NOT NULL, PRIMARY KEY (scheme, code));
-- schemes seeded: 'GICS' (from wikipedia list: sector + sub-industry names only, cc_by_sa), 'SIC' (SEC), 'INTERNAL' (asset-class buckets), 'ICB'/'NAICS' (schemes registered, codes empty)

CREATE TABLE entity_classifications (
  version_id bigserial PRIMARY KEY,
  entity_kind entity_kind NOT NULL CHECK (entity_kind IN ('issuer','instrument')),
  entity_id bigint NOT NULL, scheme text NOT NULL, code text NOT NULL,
  -- [BT]
  FOREIGN KEY (scheme, code) REFERENCES classification_codes(scheme, code),
  CONSTRAINT entity_class_bt_excl EXCLUDE USING gist (entity_kind WITH =, entity_id WITH =, scheme WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX entity_class_lookup_idx ON entity_classifications (scheme, code) WHERE tx_to = 'infinity';

CREATE TABLE calendars (
  calendar_id text PRIMARY KEY,                         -- 'XNYS','XNAS','XCBO','SIFMA','USGOV','FX_USD','TARGET2'
  name text NOT NULL, tz text NOT NULL, kind text NOT NULL CHECK (kind IN ('exchange','settlement','currency','government')),
  source_id text NOT NULL REFERENCES sources(source_id));
CREATE TABLE calendar_sessions (                        -- regular weekly template
  calendar_id text NOT NULL REFERENCES calendars(calendar_id), weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  pre_open time, open_time time NOT NULL, close_time time NOT NULL, post_close time,
  PRIMARY KEY (calendar_id, weekday));
CREATE TABLE calendar_holidays (
  calendar_id text NOT NULL REFERENCES calendars(calendar_id), day date NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('closed','early_close')), close_time time,
  PRIMARY KEY (calendar_id, day));

CREATE TABLE people (                                   -- REF-08 minimal: officers from SEC submissions/8-K 5.02 items, authors
  version_id bigserial PRIMARY KEY, person_id bigint NOT NULL, name text NOT NULL, role text, issuer_id bigint, source_id text NOT NULL,
  -- [BT]
  CONSTRAINT people_bt_excl EXCLUDE USING gist (person_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX people_name_trgm ON people USING gin (name gin_trgm_ops) WHERE tx_to = 'infinity';

CREATE TABLE entity_relations (                         -- REF-08 hierarchy/ownership shape (v1 populated from N-PORT: fund holds issuer)
  version_id bigserial PRIMARY KEY, from_kind entity_kind NOT NULL, from_id bigint NOT NULL,
  to_kind entity_kind NOT NULL, to_id bigint NOT NULL,
  relation text NOT NULL CHECK (relation IN ('parent_of','subsidiary_of','holds','officer_of','tracks','supplier_of','customer_of')),
  weight numeric(12,10), source_id text NOT NULL,
  -- [BT]
  CONSTRAINT entity_rel_bt_excl EXCLUDE USING gist (from_kind WITH =, from_id WITH =, to_kind WITH =, to_id WITH =, relation WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
```

---

## 6. Migration 0006 — bars, ticks, snapshots (STOR-01/02/05 on plain Postgres 14)

Partitioning strategy: declarative RANGE partitions, created ahead by `ingest/jobs/partition-maintenance.ts`
(`db/partitions.ts` exposes `ensurePartitions(table, throughDate)`), dropped by retention policy.
Primary keys include the partition column. Partitioned indexes are declared on the parent.

```sql
CREATE TABLE bars_daily (                               -- UNADJUSTED always (REF-09: adjust on read)
  instrument_id  bigint NOT NULL,
  md_line_id     bigint NOT NULL,
  session_date   date   NOT NULL,
  open  numeric(18,6), high numeric(18,6), low numeric(18,6), close numeric(18,6),
  volume bigint, vwap numeric(18,6), trade_count int,
  official_close numeric(18,6),                         -- exchange official close where the source says so (Cboe 'close' after session)
  source_ts      timestamptz,
  capture_ts     timestamptz NOT NULL,
  provenance_id  bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (instrument_id, md_line_id, session_date)
) PARTITION BY RANGE (session_date);
CREATE TABLE bars_daily_pre2000 PARTITION OF bars_daily FOR VALUES FROM (MINVALUE) TO ('2000-01-01');
-- yearly partitions bars_daily_y2000 … bars_daily_y2027 created in this migration; the maintenance job adds y2028+ each December.
CREATE INDEX bars_daily_date_idx ON bars_daily (session_date, instrument_id);

CREATE TABLE bars_intraday (
  instrument_id bigint NOT NULL, md_line_id bigint NOT NULL,
  interval_s    int    NOT NULL,                        -- 60, 300, 900, 3600
  bar_ts        timestamptz NOT NULL,                   -- bar start (UTC); Yahoo 'timestamp' values
  open numeric(18,6), high numeric(18,6), low numeric(18,6), close numeric(18,6), volume bigint,
  is_final      boolean NOT NULL DEFAULT false,         -- last bar of a poll is provisional
  capture_ts    timestamptz NOT NULL,
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (instrument_id, md_line_id, interval_s, bar_ts)
) PARTITION BY RANGE (bar_ts);
-- monthly partitions bars_intraday_y2026m09 …; retention: sources.retention_days (yahoo: 400) → drop partition.

CREATE TABLE ticks (                                    -- one row per observed change of a provider line (delayed "tick")
  tick_id       bigint GENERATED ALWAYS AS IDENTITY,
  instrument_id bigint NOT NULL, md_line_id bigint NOT NULL,
  kind          tick_kind NOT NULL,
  source_ts     timestamptz,                            -- FEED-05 exchange/provider published (cboe last_trade_time)
  capture_ts    timestamptz NOT NULL,                   -- FEED-05 capture
  publish_ts    timestamptz,                            -- FEED-05 plant publish
  provider_seq  bigint,                                 -- cboe seqno
  price numeric(18,6), size bigint, bid numeric(18,6), ask numeric(18,6), bid_size int, ask_size int,
  conditions    text[] NOT NULL DEFAULT '{}',           -- FEED-07 placeholder (no source supplies conditions in v1)
  session_state text,
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (capture_ts, tick_id)
) PARTITION BY RANGE (capture_ts);
-- daily partitions ticks_d20260915 …; retention 30 days (internal policy; cboe retention_days NULL).
CREATE INDEX ticks_instrument_idx ON ticks (instrument_id, capture_ts);

CREATE TABLE option_quotes (                            -- chain snapshots, 5-minute cadence while subscribed
  instrument_id bigint NOT NULL, md_line_id bigint NOT NULL, capture_ts timestamptz NOT NULL,
  bid numeric(14,4), ask numeric(14,4), bid_size int, ask_size int, last numeric(14,4), last_ts timestamptz,
  volume int, open_interest int, iv numeric(10,6), delta numeric(10,6), gamma numeric(12,8), vega numeric(12,6), theta numeric(12,6), rho numeric(12,6), theo numeric(14,6),
  underlying_px numeric(18,6), provenance_id bigint NOT NULL,
  PRIMARY KEY (capture_ts, instrument_id)
) PARTITION BY RANGE (capture_ts);                     -- daily partitions, retention 10 days
CREATE INDEX option_quotes_chain_idx ON option_quotes (instrument_id, capture_ts DESC);

CREATE TABLE quote_snapshots (                          -- warm tier for plant restart (STOR-05)
  instrument_id bigint PRIMARY KEY, seq bigint NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL);

CREATE TABLE short_interest (
  instrument_id bigint NOT NULL, settlement_date date NOT NULL, short_qty bigint, prev_short_qty bigint,
  avg_daily_volume bigint, days_to_cover numeric(10,2), change_pct numeric(10,4), provenance_id bigint NOT NULL,
  PRIMARY KEY (instrument_id, settlement_date));
```

`db/partitions.ts`:

```ts
export const partitionPlans = {
  bars_daily:    { column: 'session_date', unit: 'year',  ahead: 1,  retentionDays: null },
  bars_intraday: { column: 'bar_ts',       unit: 'month', ahead: 2,  retentionDays: 400 },
  ticks:         { column: 'capture_ts',   unit: 'day',   ahead: 7,  retentionDays: 30 },
  option_quotes: { column: 'capture_ts',   unit: 'day',   ahead: 7,  retentionDays: 10 },
  access_log:    { column: 'ts',           unit: 'month', ahead: 2,  retentionDays: 2555 }, // 7y audit window
  usage_events:  { column: 'ts',           unit: 'month', ahead: 2,  retentionDays: 730 },
} as const;
export async function ensurePartitions(db, table: keyof typeof partitionPlans, now: Date): Promise<string[]>;
export async function dropExpiredPartitions(db, table, now: Date): Promise<string[]>; // logs to ingest_runs
```

---

## 7. Migration 0007 — corporate actions and adjustment-on-read (DATA-08, REF-09)

```sql
CREATE TABLE corporate_actions (
  version_id     bigserial PRIMARY KEY,
  ca_id          bigint    NOT NULL,                    -- from ca_id_seq
  instrument_id  bigint    NOT NULL,
  ca_type        ca_type   NOT NULL,
  status         ca_status NOT NULL,                    -- estimated | announced | confirmed | paid | cancelled
  declared_date  date,
  ex_date        date      NOT NULL,
  record_date    date,
  pay_date       date,
  effective_date date,
  amount         numeric(18,8),                         -- cash per share (dividends), or cash per share for tender
  currency       char(3),
  ratio_new      numeric(18,8),                         -- split 4:1 → new=4, old=1; reverse 1:10 → new=1, old=10
  ratio_old      numeric(18,8),
  price_factor   numeric(20,12),                        -- splits/stock dividends: old/new, stored at write. Cash dividends: NULL (computed on read from close before ex_date)
  new_instrument_id bigint,                             -- spinoff/merger target
  frequency      text,                                  -- 'quarterly' …
  gross_or_net   text NOT NULL DEFAULT 'gross',
  note           text,
  source_id      text NOT NULL REFERENCES sources(source_id),
  reviewed_by    bigint,                                -- data-ops dual-key (REF-10): NULL until a human confirms high-impact actions
  reviewed_at    timestamptz,
  -- [BT]
  CONSTRAINT corporate_actions_bt_excl EXCLUDE USING gist (ca_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX ca_instrument_ex_idx ON corporate_actions (instrument_id, ex_date) WHERE tx_to = 'infinity';
CREATE INDEX ca_ex_date_idx       ON corporate_actions (ex_date) WHERE tx_to = 'infinity';
CREATE TRIGGER ca_bt_guard BEFORE UPDATE ON corporate_actions FOR EACH ROW EXECUTE FUNCTION bt_guard_update();
```

### 7.1 Adjustment policy (computed on read; one implementation: `packages/core/src/adjust/corporate-actions.ts`)

```ts
export type AdjustPolicy = 'unadjusted' | 'split' | 'split_dividend' | 'total_return';
export interface CaForAdjust { caType: CaType; exDate: string; amount?: number; ratioNew?: number; ratioOld?: number; priceFactor?: number; status: CaStatus }
export interface Bar { date: string; open?: number; high?: number; low?: number; close?: number; volume?: number }
export interface FactorStep { beforeDate: string; priceFactor: number; volumeFactor: number; kind: 'split'|'dividend' }

/**
 * Factors apply to bars with date < beforeDate (strictly before ex-date), cumulatively from latest to earliest.
 *  - split / reverse_split / stock_dividend: priceFactor = ratioOld / ratioNew (4:1 → 0.25); volumeFactor = 1/priceFactor.
 *  - cash_dividend / special_dividend / capital_return (policies split_dividend, total_return):
 *      priceFactor = 1 - amount / closeBeforeEx  where closeBeforeEx is the unadjusted close of the last
 *      session before exDate (CRSP/Yahoo convention). volumeFactor = 1.
 *  - status 'cancelled' → ignored; 'estimated' → ignored unless policy option includeEstimated=true.
 *  - policy 'total_return' additionally returns a reinvestment series: TR_t = TR_{t-1} * (P_t + D_t) / P_{t-1}.
 */
export function adjustmentFactors(actions: CaForAdjust[], bars: Bar[], policy: AdjustPolicy, opts?: { includeEstimated?: boolean }): FactorStep[];
export function applyAdjustment(bars: Bar[], steps: FactorStep[]): Bar[];    // O(n + k), prices × cumulative factor, volume × cumulative volumeFactor
export function totalReturnIndex(bars: Bar[], dividends: CaForAdjust[], base = 100): { date: string; value: number }[];
```

Read path (`packages/server/src/ca/adjust-on-read.ts`): `readBars(instrumentId, range, {policy, asOf})` loads
unadjusted bars for `[range.start − 1 session, range.end]`, loads corporate actions **as of
`asOf`** (so a backtest run "as known on 2020-08-01" does not see the AAPL split announced 2020-07-30
unless `known_at ≥` its `tx_from`), computes steps, applies, and returns bars plus the applied steps in
`meta.adjustments`. Golden values (TESTING.md): AAPL close 2020-08-28 = 499.23 unadjusted; policy
`split` → 124.8075 (4:1 on 2020-08-31); pre-2014-06-09 prices carry 1/28 (7:1 × 4:1): 645.57 → 23.0561.

---

## 8. Migration 0008 — filings and point-in-time fundamentals (DATA-06, NEWS-04, STOR-06)

```sql
CREATE TABLE filings (                                  -- SEC submissions.recent (fixture keys: accessionNumber, filingDate, reportDate, acceptanceDateTime, form, items, primaryDocument …)
  accession_no     char(20) PRIMARY KEY,                 -- '0000320193-26-000020'
  cik              char(10) NOT NULL,
  issuer_id        bigint,
  form             text NOT NULL,                        -- '10-K','10-Q','8-K','4','13F-HR','NPORT-P','SC 13G' …
  filed_date       date NOT NULL,
  accepted_at      timestamptz,                          -- acceptanceDateTime: the public knowledge instant
  report_date      date,
  items            text[] NOT NULL DEFAULT '{}',         -- 8-K items '5.02','8.01'
  primary_doc      text, primary_doc_desc text,
  is_xbrl boolean NOT NULL DEFAULT false, is_inline_xbrl boolean NOT NULL DEFAULT false,
  size_bytes       int,
  url              text NOT NULL,
  provenance_id    bigint NOT NULL REFERENCES provenance(provenance_id),
  tx_from          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX filings_issuer_idx ON filings (issuer_id, filed_date DESC);
CREATE INDEX filings_form_idx   ON filings (form, filed_date DESC);
CREATE INDEX filings_cik_idx    ON filings (cik, filed_date DESC);

CREATE TABLE xbrl_facts (                               -- one row per (concept, unit, period, accession): companyfacts is PIT by construction
  fact_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cik            char(10) NOT NULL,
  issuer_id      bigint,
  taxonomy       text NOT NULL,                          -- 'us-gaap' | 'dei'
  concept        text NOT NULL,                          -- 'NetIncomeLoss'
  unit           text NOT NULL,                          -- 'USD','shares','USD/shares'
  period_start   date,                                   -- NULL for instants (balance sheet)
  period_end     date NOT NULL,
  fy             smallint, fp text,                      -- 2026,'Q3'
  form           text NOT NULL,
  accession_no   char(20) NOT NULL,
  filed_at       date NOT NULL,                          -- 'filed' — public knowledge date (STOR-06 key)
  frame          text,                                   -- 'CY2026Q2' / 'CY2026Q2I' — SEC's canonical-period tag
  value          numeric(28,6) NOT NULL,
  tx_from        timestamptz NOT NULL DEFAULT clock_timestamp(),
  provenance_id  bigint NOT NULL REFERENCES provenance(provenance_id),
  CONSTRAINT xbrl_facts_uniq UNIQUE (cik, taxonomy, concept, unit, period_end, period_start, accession_no)
);
CREATE INDEX xbrl_facts_pit_idx   ON xbrl_facts (cik, taxonomy, concept, unit, period_end, filed_at DESC);
CREATE INDEX xbrl_facts_frame_idx ON xbrl_facts (taxonomy, concept, frame) WHERE frame IS NOT NULL;   -- EQS cross-section via frames

CREATE TABLE xbrl_concept_map (                         -- standardisation (DATA-06 "standardisation is the product")
  standard_item text NOT NULL,                           -- 'REVENUE','COGS','GROSS_PROFIT','OPEX','OPER_INC','INT_EXP','PRETAX_INC','TAX','NET_INC','EPS_BASIC','EPS_DIL','SHARES_DIL','TOT_ASSETS','TOT_LIAB','EQUITY','CASH','LT_DEBT','CFO','CAPEX','DIV_PAID','BUYBACK','DPS','RND','DDA'
  taxonomy      text NOT NULL, concept text NOT NULL,
  priority      smallint NOT NULL,                       -- lower wins when several concepts exist (Revenues=1, RevenueFromContractWithCustomerExcludingAssessedTax=2, SalesRevenueNet=3)
  sign          smallint NOT NULL DEFAULT 1,
  statement     char(2) NOT NULL CHECK (statement IN ('IS','BS','CF')),
  PRIMARY KEY (standard_item, taxonomy, concept));

CREATE TABLE fin_statements (                           -- materialised standardised statements, PIT-keyed on filed_at
  issuer_id      bigint NOT NULL,
  period_end     date   NOT NULL,
  period_type    text   NOT NULL CHECK (period_type IN ('Q','FY','TTM')),
  fiscal_year    smallint, fiscal_period text,
  filed_at       date   NOT NULL,
  accession_no   char(20) NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'USD',
  revenue numeric(28,2), cogs numeric(28,2), gross_profit numeric(28,2), opex numeric(28,2), rnd numeric(28,2),
  oper_inc numeric(28,2), int_exp numeric(28,2), pretax_inc numeric(28,2), tax numeric(28,2), net_inc numeric(28,2),
  eps_basic numeric(12,4), eps_dil numeric(12,4), shares_dil numeric(20,0),
  tot_assets numeric(28,2), tot_liab numeric(28,2), equity numeric(28,2), cash numeric(28,2), lt_debt numeric(28,2),
  cfo numeric(28,2), capex numeric(28,2), fcf numeric(28,2), div_paid numeric(28,2), buyback numeric(28,2), dps numeric(12,6), dda numeric(28,2),
  derived_q4     boolean NOT NULL DEFAULT false,         -- Q4 = FY − (Q1+Q2+Q3)
  as_reported    jsonb NOT NULL,                         -- {standard_item: {concept, value, fact_id}} — the FA "as reported" toggle
  built_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  engine_version text NOT NULL,
  PRIMARY KEY (issuer_id, period_end, period_type, filed_at)
);
```

Point-in-time read (`pit/fundamentals.repo.ts`):

```sql
-- latest value known at :known_at for each period_end (restatements are separate rows with later filed_at)
SELECT DISTINCT ON (period_end) *
FROM xbrl_facts
WHERE cik = :cik AND taxonomy = 'us-gaap' AND concept = :concept AND unit = :unit
  AND period_start IS NOT NULL AND (period_end - period_start) BETWEEN 80 AND 100     -- quarterly durations
  AND filed_at <= :known_at::date AND tx_from <= :known_at
ORDER BY period_end DESC, filed_at DESC, tx_from DESC;
```

`known_at` is a **required** parameter of every PIT repository function; screens default it to
`now`, backtests (EQS with `asOf`) pass the historical date. There is no "latest" convenience
function in this repository, by design.

---

## 9. Migration 0009 — econ series with vintages, curves, index membership (DATA-07, ANAL-02, REF-07)

```sql
CREATE TABLE econ_releases (
  release_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id           text NOT NULL REFERENCES sources(source_id),
  provider_release_id text NOT NULL,                     -- FRED rid ('10' CPI), BLS schedule name, 'FOMC'
  name text NOT NULL, country char(2) NOT NULL DEFAULT 'US', url text, importance smallint NOT NULL DEFAULT 2,
  UNIQUE (source_id, provider_release_id));

CREATE TABLE econ_series (
  series_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id      text NOT NULL REFERENCES sources(source_id),
  provider_code  text NOT NULL,                          -- 'DGS10','CUUR0000SA0','SOFR','RIFLGFCY10_N.B','NY.GDP.MKTP.CD','NGDP_RPCH'
  name           text NOT NULL, units text NOT NULL, frequency char(1) NOT NULL CHECK (frequency IN ('D','W','M','Q','A')),
  seasonal_adj   text, country char(2) NOT NULL DEFAULT 'US', release_id bigint REFERENCES econ_releases(release_id),
  instrument_id  bigint,                                 -- 'econ' instrument for the command line ('CPI YOY Index' style)
  decimals       smallint NOT NULL DEFAULT 2,
  UNIQUE (source_id, provider_code));

CREATE TABLE econ_observations (                        -- vintage = when this value became known to us; revisions add rows
  series_id     bigint NOT NULL REFERENCES econ_series(series_id),
  obs_date      date NOT NULL,
  vintage_at    timestamptz NOT NULL,
  value         numeric(20,6),                           -- NULL = 'ND'/'-' with status='missing'
  status        text NOT NULL DEFAULT 'final' CHECK (status IN ('final','preliminary','revised','missing')),
  footnote      text,                                    -- BLS 'Data unavailable due to the 2025 lapse in appropriations'
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (series_id, obs_date, vintage_at));
CREATE INDEX econ_obs_latest_idx ON econ_observations (series_id, obs_date DESC, vintage_at DESC);
-- PIT read: SELECT DISTINCT ON (obs_date) … WHERE vintage_at <= :known_at ORDER BY obs_date, vintage_at DESC

CREATE TABLE econ_release_events (                      -- ECO calendar
  event_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id     bigint NOT NULL REFERENCES econ_releases(release_id),
  scheduled_at   timestamptz NOT NULL,
  period_label   text NOT NULL,                          -- 'August 2026'
  series_id      bigint REFERENCES econ_series(series_id),
  actual         numeric(20,6), prior numeric(20,6), revised_prior numeric(20,6),
  consensus      numeric(20,6),                          -- always NULL in v1
  consensus_unavailable_reason text NOT NULL DEFAULT 'NO_CONSENSUS_SOURCE',
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','released','delayed','cancelled')),
  provenance_id  bigint NOT NULL,
  UNIQUE (release_id, scheduled_at, period_label));

CREATE TABLE curves (
  curve_id      text PRIMARY KEY,                        -- 'USD_TSY_PAR','USD_TSY_BILL','USD_CMT_H15','USD_SOFR_OIS','USD_SOFR_FIXING'
  name text NOT NULL, currency char(3) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('par','bill','ois','zero','fixing')),
  day_count text NOT NULL, source_id text NOT NULL REFERENCES sources(source_id),
  default_interpolation text NOT NULL DEFAULT 'monotone_convex');

CREATE TABLE curve_points (
  curve_id      text NOT NULL REFERENCES curves(curve_id),
  curve_date    date NOT NULL,
  tenor         text NOT NULL,                           -- '1M','1.5M','2M','3M','4M','6M','1Y','2Y','3Y','5Y','7Y','10Y','20Y','30Y' | '4WK'…'52WK' | 'ON'
  tenor_days    int  NOT NULL,
  value         numeric(12,8) NOT NULL,                  -- percent
  quote_type    text NOT NULL CHECK (quote_type IN ('par_yield','discount_rate','investment_yield','ois_rate','zero_rate','fixing')),
  instrument_id bigint,                                  -- on-the-run bill (CUSIP_13WK …)
  maturity_date date,
  vintage_at    timestamptz NOT NULL,
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  PRIMARY KEY (curve_id, curve_date, tenor, quote_type, vintage_at));

CREATE TABLE curve_builds (                             -- ANAL-08 reproducibility: bootstrapped curves are cached by inputs hash
  build_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  curve_id       text NOT NULL REFERENCES curves(curve_id), curve_date date NOT NULL,
  method         text NOT NULL, interpolation text NOT NULL,
  inputs_hash    char(64) NOT NULL, inputs jsonb NOT NULL, nodes jsonb NOT NULL,    -- nodes: [{t, df, zero}]
  engine_version text NOT NULL, built_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (curve_id, curve_date, method, interpolation, inputs_hash));

CREATE TABLE indices (
  index_id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id          bigint NOT NULL UNIQUE,         -- the 'SPX Index' instrument
  proxy_fund_instrument_id bigint,                       -- SPY (N-PORT filer)
  membership_source_id   text NOT NULL REFERENCES sources(source_id),
  provider text NOT NULL);

CREATE TABLE index_members (                            -- history of membership + weights (REF-07)
  version_id    bigserial PRIMARY KEY,
  index_id      bigint NOT NULL REFERENCES indices(index_id),
  instrument_id bigint NOT NULL,
  weight        numeric(12,10),                          -- N-PORT pctVal / 100
  shares        numeric(20,4),                           -- N-PORT balance
  market_value  numeric(20,2),                           -- N-PORT valUSD
  as_of_date    date NOT NULL,                           -- repPdDate
  -- [BT]
  CONSTRAINT index_members_bt_excl EXCLUDE USING gist (index_id WITH =, instrument_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&) WHERE (tx_to = 'infinity')
);
CREATE INDEX index_members_idx_idx  ON index_members (index_id)      WHERE tx_to = 'infinity';
CREATE INDEX index_members_inst_idx ON index_members (instrument_id) WHERE tx_to = 'infinity';
CREATE TRIGGER index_members_bt_guard BEFORE UPDATE ON index_members FOR EACH ROW EXECUTE FUNCTION bt_guard_update();
```

---

## 10. Migration 0010 — news, entity links, full text (NEWS-01/02, STOR-04)

```sql
CREATE TABLE topics (
  topic_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code      text NOT NULL UNIQUE,                         -- 'MARKETS','ECO','POLITICS','TECH','WEALTH','INDUSTRIES','FED','FILINGS','EARNINGS','CA'
  name      text NOT NULL, parent_topic_id bigint REFERENCES topics(topic_id),
  keywords  text[] NOT NULL DEFAULT '{}');

CREATE TABLE news_items (
  news_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     text NOT NULL REFERENCES sources(source_id),
  provider_guid text NOT NULL,                            -- RSS guid 'TLEUW0KGZAKZ00' | SEC accession | Fed URL
  kind          text NOT NULL CHECK (kind IN ('story','video','filing','press_release','fed_release')),
  headline      text NOT NULL,
  summary       text,
  url           text NOT NULL,
  author        text,                                     -- dc:creator
  feed          text,                                     -- 'markets','economics','politics','technology','wealth','industries','8-K','press_all'
  published_at  timestamptz NOT NULL,                     -- pubDate / <updated>
  captured_at   timestamptz NOT NULL,
  lang          char(2) NOT NULL DEFAULT 'en',
  is_machine_generated boolean NOT NULL DEFAULT false,    -- NEWS-08: always false in v1; column exists so the UI rule is enforceable
  tsv           tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english', coalesce(headline,'')), 'A') ||
                  setweight(to_tsvector('english', coalesce(summary,'')),  'B')) STORED,
  provenance_id bigint NOT NULL REFERENCES provenance(provenance_id),
  UNIQUE (source_id, provider_guid));
CREATE INDEX news_items_tsv_idx       ON news_items USING gin (tsv);
CREATE INDEX news_items_headline_trgm ON news_items USING gin (headline gin_trgm_ops);
CREATE INDEX news_items_published_idx ON news_items (published_at DESC);
CREATE INDEX news_items_feed_idx      ON news_items (feed, published_at DESC);

CREATE TABLE news_entity_links (                        -- NEWS-02 precision-first entity resolution
  news_id     bigint NOT NULL REFERENCES news_items(news_id) ON DELETE CASCADE,
  entity_kind entity_kind NOT NULL,                       -- instrument | issuer | person | topic
  entity_id   bigint NOT NULL,
  confidence  real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  method      text NOT NULL CHECK (method IN ('cik','ticker_exact','name_exact','name_alias','feed_topic','manual')),
  PRIMARY KEY (news_id, entity_kind, entity_id));
CREATE INDEX news_links_entity_idx ON news_entity_links (entity_kind, entity_id, news_id DESC);

CREATE TABLE issuer_aliases (                           -- for name matching: 'Apple' → issuer; from SEC formerNames + curated
  issuer_id bigint NOT NULL, alias text NOT NULL, kind text NOT NULL CHECK (kind IN ('former_name','short_name','brand','curated')),
  PRIMARY KEY (issuer_id, alias));
CREATE INDEX issuer_aliases_trgm ON issuer_aliases USING gin (alias gin_trgm_ops);
```

---

## 11. Migration 0011 — firms, users, sessions, entitlements, access log (ENTL-*, SEC-01/03)

```sql
CREATE TABLE firms (
  firm_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      text NOT NULL, contract_ref text,
  allow_concurrent_sessions boolean NOT NULL DEFAULT false,
  retention_days int NOT NULL DEFAULT 2555,               -- messages/access-log retention floor (7y)
  data_residency text NOT NULL DEFAULT 'us',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp());

CREATE TABLE users (
  user_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id  bigint NOT NULL REFERENCES firms(firm_id),
  email    text NOT NULL, display_name text NOT NULL, desk text,
  role     text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','compliance','dataops','helpdesk')),
  person_verified_at timestamptz,                         -- SEC-01 onboarding evidence
  status   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deprovisioned')),
  sanctions_screened_at timestamptz, sanctions_status text, -- REG-06 mechanism (manual in v1)
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), deprovisioned_at timestamptz);
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email));

CREATE TABLE user_credentials (
  user_id       bigint NOT NULL REFERENCES users(user_id),
  kind          text NOT NULL CHECK (kind IN ('password','webauthn')),
  credential_id bytea NOT NULL DEFAULT ''::bytea,        -- WebAuthn credential id; empty for password
  public_key    bytea, secret_hash text,                  -- scrypt hash for password
  sign_count    bigint NOT NULL DEFAULT 0, transports text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_used_at timestamptz,
  PRIMARY KEY (user_id, kind, credential_id));

CREATE TABLE sessions (
  session_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      bigint NOT NULL REFERENCES users(user_id),
  token_hash   bytea NOT NULL UNIQUE,                     -- sha256(token); token itself never stored
  client_kind  text NOT NULL CHECK (client_kind IN ('web','api')),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(), last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at   timestamptz NOT NULL, ip inet, user_agent text,
  mfa_verified boolean NOT NULL DEFAULT false,
  revoked_at   timestamptz, revoke_reason text);         -- 'logout','superseded','expired','admin','concurrent_detected'
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE entitlement_grants (                       -- ENTL-02: evaluated as user ∩ firm ∩ source
  grant_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('user','firm')),
  subject_id   bigint NOT NULL,
  source_id    text REFERENCES sources(source_id),        -- NULL = all sources
  asset_class  asset_class,                               -- NULL = all
  field_class  field_class,                               -- NULL = all
  max_tier     tier NOT NULL,
  usage_display boolean NOT NULL DEFAULT true, usage_export boolean NOT NULL DEFAULT false, usage_api boolean NOT NULL DEFAULT false,
  valid_from   timestamptz NOT NULL DEFAULT clock_timestamp(), valid_to timestamptz NOT NULL DEFAULT 'infinity',
  granted_by   bigint, note text);
CREATE INDEX grants_subject_idx ON entitlement_grants (subject_kind, subject_id) WHERE valid_to = 'infinity';

CREATE TABLE access_log (                               -- ENTL-04: every data access; batched insert; partitioned monthly
  log_id        bigint GENERATED ALWAYS AS IDENTITY,
  ts            timestamptz NOT NULL,
  user_id       bigint NOT NULL, firm_id bigint NOT NULL, session_id uuid,
  instrument_id bigint,                                   -- NULL for non-instrument reads (econ series → series_id in details)
  field_id      text NOT NULL,
  source_id     text NOT NULL,
  tier          tier NOT NULL,
  usage         usage_type NOT NULL,
  purpose       text NOT NULL,                            -- function code or route id
  decision      entl_decision NOT NULL,
  reason        text,
  trace_id      uuid,
  details       jsonb,
  PRIMARY KEY (ts, log_id)
) PARTITION BY RANGE (ts);
CREATE INDEX access_log_user_idx   ON access_log (user_id, ts);
CREATE INDEX access_log_source_idx ON access_log (source_id, ts);

CREATE TABLE usage_declarations (                       -- ENTL-06 / DATA-02: generated monthly from access_log
  declaration_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month date NOT NULL, source_id text NOT NULL REFERENCES sources(source_id), firm_id bigint NOT NULL,
  user_count int NOT NULL, display_users int NOT NULL, export_users int NOT NULL, api_users int NOT NULL,
  instrument_count int NOT NULL, data_points bigint NOT NULL,
  query_sql_hash char(64) NOT NULL, generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reconciled_at timestamptz, billing_ref text,
  UNIQUE (month, source_id, firm_id));

CREATE TABLE quota_counters (                           -- API-06
  user_id bigint NOT NULL, window_kind text NOT NULL CHECK (window_kind IN ('day','month')), window_start date NOT NULL,
  data_points bigint NOT NULL DEFAULT 0, PRIMARY KEY (user_id, window_kind, window_start));
CREATE TABLE quota_instruments_seen (user_id bigint NOT NULL, day date NOT NULL, instrument_id bigint NOT NULL, PRIMARY KEY (user_id, day, instrument_id));
CREATE TABLE quota_limits (
  subject_kind text NOT NULL, subject_id bigint NOT NULL,
  daily_unique_instruments int NOT NULL DEFAULT 5000, monthly_data_points bigint NOT NULL DEFAULT 10000000, concurrent_subscriptions int NOT NULL DEFAULT 10000,
  PRIMARY KEY (subject_kind, subject_id));
```

---

## 12. Migration 0012 — workspaces, watchlists, portfolios, messaging, alerts (TERM-05, PORT-*, MSG-*, NEWS-07)

```sql
CREATE TABLE workspaces (
  workspace_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(user_id), name text NOT NULL DEFAULT 'default',
  layout jsonb NOT NULL,                                  -- CLIENT.md §6 WorkspaceLayout (panels, monitors, chart settings)
  version int NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, name));

CREATE TABLE watchlists (
  watchlist_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES users(user_id), firm_id bigint NOT NULL REFERENCES firms(firm_id),
  name text NOT NULL, columns jsonb NOT NULL,             -- [{fieldId | formula, width, format}]
  shared_scope text NOT NULL DEFAULT 'private' CHECK (shared_scope IN ('private','firm')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE watchlist_items (
  watchlist_id bigint NOT NULL REFERENCES watchlists(watchlist_id) ON DELETE CASCADE, instrument_id bigint NOT NULL,
  position int NOT NULL, note text, added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (watchlist_id, instrument_id));

CREATE TABLE portfolios (                               -- PORT-07: tenant-isolated (RLS in 0014)
  portfolio_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id bigint NOT NULL REFERENCES firms(firm_id), owner_user_id bigint NOT NULL REFERENCES users(user_id),
  name text NOT NULL, base_currency char(3) NOT NULL DEFAULT 'USD', benchmark_instrument_id bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE portfolio_uploads (
  upload_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, portfolio_id bigint NOT NULL REFERENCES portfolios(portfolio_id),
  firm_id bigint NOT NULL, filename text NOT NULL, uploaded_by bigint NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_count int NOT NULL, error_count int NOT NULL, errors jsonb NOT NULL DEFAULT '[]',   -- PORT-01 reconciliation report
  status text NOT NULL CHECK (status IN ('accepted','rejected','partial')));
CREATE TABLE positions (
  position_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id bigint NOT NULL REFERENCES portfolios(portfolio_id), firm_id bigint NOT NULL,
  instrument_id bigint NOT NULL, quantity numeric(20,6) NOT NULL,
  cost_basis numeric(18,6), cost_currency char(3), lot_date date, accrued numeric(18,6), as_of date NOT NULL,
  source text NOT NULL CHECK (source IN ('upload','api','manual')), upload_id bigint,
  UNIQUE (portfolio_id, instrument_id, lot_date, as_of));
CREATE INDEX positions_portfolio_idx ON positions (portfolio_id, as_of DESC);

CREATE TABLE rooms (
  room_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('dm','room','helpdesk')), name text,
  firm_id bigint REFERENCES firms(firm_id),               -- NULL for cross-firm dm/rooms
  created_by bigint NOT NULL REFERENCES users(user_id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  policy jsonb NOT NULL DEFAULT '{}');                   -- MSG-03: {disclaimer, retentionDays, ethicalWallGroups[], permittedFirms[]}
CREATE TABLE room_members (
  room_id bigint NOT NULL REFERENCES rooms(room_id), user_id bigint NOT NULL REFERENCES users(user_id),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner','supervisor')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(), left_at timestamptz,
  PRIMARY KEY (room_id, user_id));

CREATE TABLE messages (                                 -- MSG-02 / REG-01 WORM: append-only, hash-chained (0014 revokes UPDATE/DELETE)
  message_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id        bigint NOT NULL REFERENCES rooms(room_id),
  sender_user_id bigint NOT NULL REFERENCES users(user_id),
  sent_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  body           text NOT NULL,
  attachments    jsonb NOT NULL DEFAULT '[]',            -- MSG-04: [{kind:'security'|'chart'|'function'|'portfolio', ref, params}] — render within recipient entitlements
  client_msg_id  uuid NOT NULL,
  prev_hash      bytea,                                   -- hash of the previous message in the room
  hash           bytea NOT NULL,                          -- sha256(prev_hash || room_id || sender || sent_at || body || attachments)
  UNIQUE (room_id, client_msg_id));
CREATE INDEX messages_room_idx ON messages (room_id, message_id DESC);

CREATE TABLE message_reviews (                          -- supervisory queue + lexicon surveillance
  review_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, message_id bigint NOT NULL REFERENCES messages(message_id),
  flagged_by text NOT NULL CHECK (flagged_by IN ('lexicon','random_sample','manual')), lexicon_term text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','escalated')),
  reviewer_user_id bigint, reviewed_at timestamptz, note text);
CREATE TABLE legal_holds (
  hold_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, firm_id bigint NOT NULL, room_id bigint, user_id bigint,
  from_ts timestamptz NOT NULL, to_ts timestamptz, reason text NOT NULL, created_by bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz);

CREATE TABLE alerts (
  alert_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(user_id),
  kind text NOT NULL CHECK (kind IN ('price','news','filing','calendar')),
  condition jsonb NOT NULL,                               -- price: {instrumentId, field, op, value}; news: {query, instrumentIds[], topics[]}; filing: {cik[], forms[]}; calendar: {releaseIds[], minutesBefore}
  delivery text[] NOT NULL DEFAULT '{inapp}',             -- 'inapp','email','push' (email/push = recorded intents in v1)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','fired')), one_shot boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_fired_at timestamptz);
CREATE TABLE alert_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, alert_id bigint NOT NULL REFERENCES alerts(alert_id),
  fired_at timestamptz NOT NULL, payload jsonb NOT NULL, delivered jsonb NOT NULL DEFAULT '{}', acknowledged_at timestamptz);

CREATE TABLE chart_annotations (                        -- CHRT-05 anchored in data coordinates
  annotation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_user_id bigint NOT NULL, firm_id bigint NOT NULL,
  instrument_id bigint NOT NULL, kind text NOT NULL CHECK (kind IN ('trendline','hline','vline','fib','text','regression_channel','rect')),
  anchors jsonb NOT NULL,                                 -- [{t: ISO, y: number}] up to 2 (regression: {t0,t1,stdev})
  style jsonb NOT NULL DEFAULT '{}', label text, shared_scope text NOT NULL DEFAULT 'private',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());

CREATE TABLE saved_searches (
  search_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL, function_code text NOT NULL,
  name text NOT NULL, params jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
```

---

## 13. Migration 0013 — ops: usage events, help tickets, DQ, ingest runs, data exceptions

```sql
CREATE TABLE usage_events (                             -- FUNC-04
  event_id bigint GENERATED ALWAYS AS IDENTITY, ts timestamptz NOT NULL,
  user_id bigint NOT NULL, session_id uuid, panel_id text, function_code text,
  event_kind text NOT NULL CHECK (event_kind IN ('launch','param_change','export','help','navigate','ticket','subscribe')),
  params jsonb, duration_ms int, trace_id uuid,
  PRIMARY KEY (ts, event_id)
) PARTITION BY RANGE (ts);
CREATE INDEX usage_events_fn_idx ON usage_events (function_code, ts);

CREATE TABLE help_tickets (                             -- TERM-09 second press
  ticket_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id bigint NOT NULL, opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  function_code text, panel_state jsonb NOT NULL, trace_id uuid, room_id bigint REFERENCES rooms(room_id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')), answered_at timestamptz);

CREATE TABLE dq_events (                                -- OPS-03 / QA-03
  dq_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ts timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('stale_tick','cross_source_divergence','missing_close','field_population','rate_anomaly','reconcile_mismatch','parse_error')),
  severity text NOT NULL CHECK (severity IN ('info','warn','error')),
  instrument_id bigint, md_line_id bigint, source_id text, details jsonb NOT NULL, resolved_at timestamptz);
CREATE INDEX dq_events_open_idx ON dq_events (kind, ts DESC) WHERE resolved_at IS NULL;

CREATE TABLE ingest_runs (
  run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job text NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  fetched int NOT NULL DEFAULT 0, inserted int NOT NULL DEFAULT 0, updated int NOT NULL DEFAULT 0, skipped int NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]', trace_id uuid);
CREATE INDEX ingest_runs_job_idx ON ingest_runs (job, started_at DESC);

CREATE TABLE data_exceptions (                          -- REF-10 exception queue (source conflicts, parse failures, manual review)
  exception_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind IN ('source_conflict','missing_field','parse_error','manual_review','reported_error')),
  entity_kind entity_kind, entity_id bigint, field text, candidates jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  assignee_user_id bigint, resolved_by bigint, resolution jsonb, resolved_at timestamptz,
  sla_due_at timestamptz);                                -- REF-10 SLA on correcting reported errors
```

---

## 14. Migration 0014 — RLS, WORM, role grants (PORT-07, SEC-05, MSG-02, REG-01)

```sql
CREATE ROLE terminal_app LOGIN;                         -- server connects as this role; owner role runs migrations
GRANT USAGE ON SCHEMA public TO terminal_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO terminal_app;
GRANT UPDATE ON ALL TABLES IN SCHEMA public TO terminal_app;          -- then narrowed:
REVOKE UPDATE, DELETE ON messages, access_log, provenance, usage_events FROM terminal_app;   -- WORM / audit tables
REVOKE DELETE ON issuers, issues, instruments, listings, md_lines, identifiers, govt_terms, option_terms, future_terms, fund_terms,
                 index_terms, fx_terms, rate_terms, entity_classifications, people, entity_relations, corporate_actions, index_members FROM terminal_app;
GRANT DELETE ON watchlist_items, room_members, alerts, chart_annotations, saved_searches, quota_instruments_seen TO terminal_app;

-- Tenant isolation: the app sets `SET LOCAL app.firm_id = <id>` and `app.user_id` inside every transaction (db/tenant.ts withTenant()).
ALTER TABLE portfolios        ENABLE ROW LEVEL SECURITY;  ALTER TABLE portfolios        FORCE ROW LEVEL SECURITY;
ALTER TABLE positions         ENABLE ROW LEVEL SECURITY;  ALTER TABLE positions         FORCE ROW LEVEL SECURITY;
ALTER TABLE portfolio_uploads ENABLE ROW LEVEL SECURITY;  ALTER TABLE portfolio_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE watchlists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_annotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY portfolios_tenant ON portfolios USING (firm_id = current_setting('app.firm_id', true)::bigint);
CREATE POLICY positions_tenant  ON positions  USING (firm_id = current_setting('app.firm_id', true)::bigint);
CREATE POLICY uploads_tenant    ON portfolio_uploads USING (firm_id = current_setting('app.firm_id', true)::bigint);
CREATE POLICY watchlists_scope  ON watchlists USING (owner_user_id = current_setting('app.user_id', true)::bigint
                                                  OR (shared_scope = 'firm' AND firm_id = current_setting('app.firm_id', true)::bigint));
CREATE POLICY workspaces_owner  ON workspaces USING (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY annotations_scope ON chart_annotations USING (owner_user_id = current_setting('app.user_id', true)::bigint
                                                  OR (shared_scope = 'firm' AND firm_id = current_setting('app.firm_id', true)::bigint));
CREATE POLICY messages_member   ON messages USING (
  EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = messages.room_id AND m.user_id = current_setting('app.user_id', true)::bigint AND m.left_at IS NULL)
  OR current_setting('app.role', true) = 'compliance');   -- SEC-06: news staff role never has 'compliance'; 'reporter' role has no grant on portfolio tables at all

-- WORM triggers (defence in depth on top of REVOKE)
CREATE FUNCTION worm_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER messages_worm   BEFORE UPDATE OR DELETE ON messages   FOR EACH ROW EXECUTE FUNCTION worm_block();
CREATE TRIGGER access_log_worm BEFORE UPDATE OR DELETE ON access_log FOR EACH ROW EXECUTE FUNCTION worm_block();
CREATE TRIGGER provenance_worm BEFORE UPDATE OR DELETE ON provenance FOR EACH ROW EXECUTE FUNCTION worm_block();

-- Hash chain
CREATE FUNCTION messages_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev bytea;
BEGIN
  SELECT hash INTO prev FROM messages WHERE room_id = NEW.room_id ORDER BY message_id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := digest(coalesce(prev, ''::bytea) || convert_to(NEW.room_id::text || '|' || NEW.sender_user_id::text || '|' || NEW.sent_at::text || '|' || NEW.body || '|' || NEW.attachments::text, 'UTF8'), 'sha256');
  RETURN NEW;
END $$;
CREATE TRIGGER messages_chain_trg BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_chain();
```

`db/tenant.ts`:

```ts
export async function withTenant<T>(db: Db, ctx: { userId: number; firmId: number; role: string }, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${String(ctx.userId)}, true), set_config('app.firm_id', ${String(ctx.firmId)}, true), set_config('app.role', ${ctx.role}, true)`);
    return fn(tx);
  });
}
```

---

## 15. Index summary (beyond PKs and the ones inline above)

| Table | Index | Purpose |
| --- | --- | --- |
| instruments | `(upper(ticker), market_sector)` partial current | command-line resolve `AAPL US Equity` |
| instruments, issuers, people, identifiers | `gin_trgm_ops` | autocomplete fallback beyond the in-memory index |
| bars_daily | `(session_date, instrument_id)` | cross-section reads (EQS, WEI), partition-pruned |
| xbrl_facts | `(taxonomy, concept, frame)` | EQS factor cross-sections via SEC frames |
| news_items | GIN tsv, trigram headline, `(published_at DESC)`, `(feed, published_at DESC)` | N / TOP / NI |
| access_log | `(user_id, ts)`, `(source_id, ts)` | declarations, audit |
| econ_observations | `(series_id, obs_date DESC, vintage_at DESC)` | PIT vintage reads |
| curve_points | PK covers `(curve_id, curve_date, tenor, quote_type, vintage_at)` | curve loads |

---

## 16. Seed strategy and volumes (`packages/server/src/seed/*`, offline from the replay store)

| Domain | Source fixture(s) | Rows (approx.) |
| --- | --- | --- |
| issuers/issues/instruments/listings | `sec-company-tickers.json` (10,422 tickers → issuers with CIK), `openfigi-map`/`openfigi-search` (AAPL 275 venue listings; universe mapped lazily by `symbology-refresh`), `cboe-symbol-book.json` (35,618 symbols → search candidates), `sec-nport-SPY-primary_doc.xml` (504 S&P names with CUSIP/ISIN/LEI) | issuers ~10.5k, instruments ~11k equity/ETF + 20 indices + 9 FX + 2 crypto + 15 govt + 5 rates + ~60 econ, listings ~1.5k (S&P names only at seed), md_lines ~2.2k |
| identifiers | above | ~45k |
| govt_terms | `treasury-bills.xml` (7 on-the-run bills with CUSIPs/maturities), curated on-the-run notes/bonds (2/3/5/7/10/20/30) | 15 |
| option_terms | `cboe-options` (AAPL chain 3,510 contracts) | 3,510 |
| calendars | code-generated NYSE/SIFMA/USGOV/FX rules 2000–2030 | ~1,200 holiday rows |
| classifications | `wiki-sp500.html` (GICS sector/sub-industry names + CIK → S&P names), SEC `sic` | GICS ~180 codes, SIC ~440 codes, ~11k entity_classifications |
| bars_daily | `yahoo-chart-AAPL-max-1d.json` (169 quarterly points, max range), `yahoo-chart-events` (1,255 daily bars 5y + dividends), `fred-DGS10.csv` (16,879 obs → econ) — seed universe fetches 10y daily per instrument in `record` mode; offline seed covers instruments present in fixtures | offline: ~1.5k; live: ~1.4M (550 × 2,520) |
| bars_intraday | `yahoo-chart-AAPL-1d-1m.json` (317 × 1m), `yahoo-chart-SPX-5d-5m.json`, `yahoo-fx`, `yahoo-ftse`, `yahoo-bond` | offline ~1k; live ~1M/week |
| ticks | `cboe-quote-AAPL.json`, `cboe-spx`, `cboe-vix`, `cboe-eu-indices` (one poll each) | seeds plant snapshots; live ~860k/day |
| corporate_actions | `yahoo-chart-events` dividends (AAPL 2021–2026), curated AAPL splits 2014-06-09 (7:1), 2020-08-31 (4:1) | ~25 |
| filings / xbrl_facts / fin_statements | `sec-submissions-AAPL.json` (1,000 filings), `sec-spy-submissions.json`, `sec-companyfacts-AAPL.json` (503 us-gaap concepts, ~40k facts), `sec-frames-assets.json` (6,264 CIKs Assets CY2024Q4I) | facts ~46k; statements ~120 (AAPL Q/FY/TTM) |
| econ | `fred-DGS10.csv`, `fed-h15.csv`, `nyfed-all/effr/sofr`, `bls-cpi.json`, `worldbank`, `imf-weo.json` (indicator metadata only), `frankfurter` | series ~70; observations ~17.5k |
| curves | `treasury-xml2` (10 days par curve), `treasury-bills.xml`, `fed-h15.csv`, `nyfed-sofr` | ~250 points |
| index_members | `sec-nport-SPY-primary_doc.xml` (504 holdings, repPdDate 2026-06-30) | 504 |
| news | `bbg-rss-{markets,econ,politics,tech,industries}` (~25 items each), `sec-8k-atom.xml` (40 filings), `fed-press-rss.xml` | ~200 items, ~400 links |
| econ_release_events | `bls-schedule.html` (September 2026), `fred-cal` (release names), FOMC dates (curated 2026) | ~60 |
| sources/source_fields | `seed/licences.ts` | 21 sources, ~400 field mappings |
| firms/users/grants | `seed/users.ts`: firm "Demo Capital" (retention 7y), users `pm@demo`, `analyst@demo`, `compliance@demo`, `dataops@demo`, `reporter@newsco` (SEC-06 test); grants: firm=delayed/display+export; pm=delayed+api | 2 firms, 5 users, 6 grants |
| workspaces/watchlists | default 4-panel layout; watchlist "MAG7", "S&P 500 Top 25" | 2 |
| short_interest | `finra-trace` (1 row, A) | 1 |

Seed is idempotent (`upsertVersion` no-ops on identical data) and records `provenance` rows pointing at
the fixture paths, so even seeded numbers have provenance.
