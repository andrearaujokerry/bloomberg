# DATA_MODEL — candidate C

Postgres 14, extensions `pg_trgm`, `btree_gist`, `pgcrypto` (no TimescaleDB, no pgvector). Drizzle schema files
live in `packages/server/src/db/schema/*.ts` and mirror the SQL below one-to-one; the **committed SQL
migrations** in `packages/server/src/db/migrations/NNNN_*.sql` are the source of truth (Drizzle cannot express
exclusion constraints, partitions, generated tsvector columns, RLS or triggers, so those are hand-written and
Drizzle's schema uses `sql` tags / `customType` where needed).

Migration files: `0001_extensions_enums_functions.sql`, `0002_reference.sql`, `0003_timeseries.sql`,
`0004_fundamentals_econ.sql`, `0005_news_curves.sql`, `0006_users_entitlements.sql`, `0007_workspace_msg.sql`,
`0008_ops.sql`, `0009_indexes.sql`, `0010_rls_triggers.sql`.

Conventions:

* Times are `timestamptz`; dates that are calendar dates (`bar_date`, `ex_date`, `filed_at`) are `date`.
* Money/rates are `numeric` (never `float8`) in storage; analytics run in IEEE doubles from the numeric text
  (the SDK parses `numeric` to JS `number`; values needing more than 15 significant digits do not occur in
  the wedge).
* Every value-bearing table has `prov_id bigint NOT NULL REFERENCES provenance(id)`.
* "Bitemporal" means the six columns in §1.2 and the exclusion constraint; the current version of a row is
  `valid_to = 'infinity' AND tx_to = 'infinity'` for "current, currently believed".
* Corporate-action adjustment is **not** implemented in SQL. `bar_daily` stores unadjusted values; the
  historical data service applies factors from `@terminal/core/analytics/adjust.ts` on read (§3.3).

## 1. Foundations

### 1.1 Extensions, enums, helper functions (`0001`)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE asset_class AS ENUM ('equity','etf','index','fx','govt','option','future','crypto','rate','econ');
CREATE TYPE data_tier   AS ENUM ('eod','delayed','realtime');       -- ordered: eod < delayed < realtime
CREATE TYPE usage_type  AS ENUM ('display','export','api');
CREATE TYPE ca_type     AS ENUM ('dividend','special_dividend','split','reverse_split','spinoff','merger',
                                 'tender','rights','name_change','ticker_change','delisting','call',
                                 'conversion','capital_return');
CREATE TYPE ca_status   AS ENUM ('estimated','announced','confirmed','cancelled');
CREATE TYPE session_state AS ENUM ('pre','open','halted','auction','closed','post','unknown');

-- ordering helper for tiers (used by the entitlement engine and tests)
CREATE FUNCTION tier_rank(t data_tier) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE t WHEN 'eod' THEN 0 WHEN 'delayed' THEN 1 WHEN 'realtime' THEN 2 END $$;

-- bitemporal predicate: is this version the one valid at valid_at as known at known_at?
CREATE FUNCTION bt_at(valid_from timestamptz, valid_to timestamptz, tx_from timestamptz, tx_to timestamptz,
                      valid_at timestamptz, known_at timestamptz) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT valid_from <= valid_at AND valid_at < valid_to AND tx_from <= known_at AND known_at < tx_to $$;

-- supersede: close the transaction time of the current version(s) of a key and insert the new version.
-- Called by the ref services inside one transaction; generic over table name (EXECUTE) so that every
-- bitemporal table shares one implementation (tested in bitemporal.spec.ts).
CREATE FUNCTION bt_close_tx(tbl regclass, key_col text, key_val text, valid_from timestamptz, valid_to timestamptz)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  EXECUTE format(
    'UPDATE %s SET tx_to = now() WHERE %I = $1 AND tx_to = ''infinity''
       AND tstzrange(valid_from, valid_to, ''[)'') && tstzrange($2, $3, ''[)'')', tbl, key_col)
    USING key_val, valid_from, valid_to;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
```

### 1.2 Bitemporal column block (repeated verbatim in every bitemporal table)

```sql
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz NOT NULL DEFAULT 'infinity',
  tx_from     timestamptz NOT NULL DEFAULT now(),
  tx_to       timestamptz NOT NULL DEFAULT 'infinity',
  prov_id     bigint      NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to)
```

and, per table, the exclusion constraint that guarantees at most one version per (key, valid_at, known_at):

```sql
  EXCLUDE USING gist (<key> WITH =,
                      tstzrange(valid_from, valid_to, '[)') WITH &&,
                      tstzrange(tx_from,   tx_to,   '[)') WITH &&)
```

`as_of` helper (Drizzle side, `packages/server/src/db/asOf.ts`):

```ts
export interface AsOf { validAt: Date; knownAt: Date }              // defaults: both = ctx.now()
export const asOf = (t: BitemporalCols, a: AsOf) =>
  and(lte(t.validFrom, a.validAt), gt(t.validTo, a.validAt), lte(t.txFrom, a.knownAt), gt(t.txTo, a.knownAt));
export const current = (t: BitemporalCols) => and(eq(t.validTo, INFINITY), eq(t.txTo, INFINITY));
// Semantics: a CHANGE (coupon effective from D) inserts a new version with valid_from = D and closes the
// old version's valid_to = D (both with tx_from = now()); a CORRECTION (we were wrong all along) calls
// bt_close_tx on the same valid range and inserts a version with the same valid range and tx_from = now().
```

### 1.3 Provenance and licence registry (created first; everything references them)

```sql
CREATE TABLE licence_registry (
  id              text PRIMARY KEY,                -- 'cboe_delayed', 'openfigi', 'sec_edgar', ...
  provider_id     text NOT NULL UNIQUE,            -- adapter id, e.g. 'cboe.quotes'
  source_name     text NOT NULL,
  terms_url       text,
  display         boolean NOT NULL DEFAULT true,   -- display use
  non_display     boolean NOT NULL DEFAULT false,  -- programmatic/non-display use (DATA-01 distinction)
  derived         boolean NOT NULL DEFAULT true,   -- may compute derived data
  redistribution  boolean NOT NULL DEFAULT false,  -- may redistribute outside the app
  export          boolean NOT NULL DEFAULT true,   -- CSV export allowed
  api             boolean NOT NULL DEFAULT true,   -- API (usage 'api') allowed
  max_tier        data_tier NOT NULL DEFAULT 'delayed',
  retention_days  int,                             -- NULL = unlimited (STOR-07)
  attribution     text,
  notes           text,
  valid_from      date NOT NULL DEFAULT current_date,
  valid_to        date NOT NULL DEFAULT 'infinity'
);

CREATE TABLE provenance (
  id               bigserial PRIMARY KEY,
  provider_id      text NOT NULL REFERENCES licence_registry(provider_id),
  request_url      text NOT NULL,
  request_hash     bytea NOT NULL,                 -- sha256(method + url + body)
  response_sha256  bytea NOT NULL,
  http_status      int  NOT NULL,
  bytes            int  NOT NULL,
  captured_at      timestamptz NOT NULL,           -- capture timestamp (FEED-05 'cap')
  source_ts        timestamptz,                    -- provider-published timestamp when present ('src')
  replay_key       text NOT NULL,                  -- fixtures/providers/replay/<provider>/<key>.json
  trace_id         text,
  licence_id       text NOT NULL REFERENCES licence_registry(id)
);
CREATE INDEX provenance_provider_captured_idx ON provenance (provider_id, captured_at DESC);
CREATE UNIQUE INDEX provenance_replay_key_idx ON provenance (replay_key);
```

## 2. Security master (`0002`)

### 2.1 Hierarchy: issuer → issue → instrument → listing → md_line

```sql
CREATE TABLE issuer (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  lei               char(20),
  cik               int,
  country           char(2),
  state_of_inc      text,
  sic               text, sic_description text,
  entity_type       text,                          -- SEC entityType: operating|other|...
  fiscal_year_end   char(4),                       -- 'MMDD' from SEC submissions
  website           text,
  former_names      jsonb NOT NULL DEFAULT '[]',   -- [{name, from, to}] from SEC submissions
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX issuer_cik_idx ON issuer (cik) WHERE tx_to = 'infinity';
CREATE INDEX issuer_lei_idx ON issuer (lei) WHERE tx_to = 'infinity';
CREATE INDEX issuer_name_trgm_idx ON issuer USING gin (name gin_trgm_ops);

CREATE TABLE issue (                                 -- share class / debt issue / fund share class / index / pair
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  issuer_id         uuid NOT NULL,                   -- FK by convention (bitemporal target rows have no unique id)
  kind              text NOT NULL CHECK (kind IN ('share_class','debt','fund_share','index','fx_pair','rate','option_series','future_series','crypto','econ_series')),
  name              text NOT NULL,
  share_class_figi  char(12),
  cusip             char(9), isin char(12), sedol char(7),
  currency          char(3),
  par_value         numeric(18,6),
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX issue_issuer_idx ON issue (issuer_id) WHERE tx_to = 'infinity';

CREATE TABLE instrument (                            -- the composite-level security ("AAPL US")
  id                  char(12) NOT NULL CHECK (id ~ '^[A-Z0-9]{12}$'),  -- FIGI (composite) or minted TRM………
  issue_id            uuid NOT NULL,
  asset_class         asset_class NOT NULL,
  market_sector       text NOT NULL CHECK (market_sector IN ('Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto')),
  security_type       text NOT NULL,               -- OpenFIGI securityType: 'Common Stock','ETP','REIT','Index','Equity Option', ...
  security_type2      text,
  name                text NOT NULL,
  ticker              text NOT NULL,               -- display/search only; NEVER a key (REF-01)
  currency            char(3) NOT NULL,
  composite_figi      char(12),
  primary_exch_code   text,                        -- OpenFIGI exchCode of the primary listing ('UW')
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','delisted','matured','expired','suspended')),
  first_trade_date    date, last_trade_date date,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX instrument_ticker_idx ON instrument (upper(ticker), market_sector) WHERE tx_to = 'infinity' AND valid_to = 'infinity';
CREATE INDEX instrument_name_trgm_idx ON instrument USING gin (name gin_trgm_ops);
CREATE INDEX instrument_asset_class_idx ON instrument (asset_class) WHERE tx_to = 'infinity';

CREATE TABLE listing (                               -- exchange-level line ("AAPL UW")
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  instrument_id char(12) NOT NULL,
  figi          char(12),                            -- exchange-level FIGI (e.g. BBG000B9Y5X2 for UW)
  exch_code     text NOT NULL,                       -- OpenFIGI exchCode
  mic           char(4),                             -- REFERENCES exchange(mic) by convention
  ticker        text NOT NULL,
  currency      char(3) NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX listing_instrument_idx ON listing (instrument_id) WHERE tx_to = 'infinity';
CREATE INDEX listing_figi_idx ON listing (figi) WHERE tx_to = 'infinity';

CREATE TABLE md_line (                               -- a market-data line: provider × symbol × tier for a listing/instrument
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  instrument_id   char(12) NOT NULL,
  listing_id      uuid,                              -- NULL for composite lines
  provider_id     text NOT NULL REFERENCES licence_registry(provider_id),
  provider_symbol text NOT NULL,                     -- 'AAPL', '_SPX', 'EURUSD=X', '^FTSE', 'DGS10', 'SOFR'
  kind            text NOT NULL CHECK (kind IN ('quote','bars_intraday','bars_daily','chain','rate','series','curve','holdings')),
  tier            data_tier NOT NULL,
  is_primary      boolean NOT NULL DEFAULT false,    -- primary line per (instrument, kind)
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX md_line_lookup_idx ON md_line (provider_id, provider_symbol) WHERE tx_to = 'infinity';
CREATE INDEX md_line_instrument_idx ON md_line (instrument_id, kind) WHERE tx_to = 'infinity';
```

Foreign keys between bitemporal tables are enforced by the ref service (a version of `listing` references
the immutable `instrument.id`, not a version), and by a nightly `dq` check `ref.orphans`.

### 2.2 Identifier cross-reference (REF-01)

```sql
CREATE TABLE identifier_xref (
  id           bigserial,
  entity_kind  text NOT NULL CHECK (entity_kind IN ('issuer','issue','instrument','listing')),
  entity_id    text NOT NULL,                        -- uuid text or instrument char(12)
  id_type      text NOT NULL CHECK (id_type IN ('FIGI','COMPOSITE_FIGI','SHARE_CLASS_FIGI','ISIN','CUSIP','SEDOL','RIC',
                 'TICKER_EXCH','LEI','CIK','MIC','OCC','YAHOO','CBOE','STOOQ','FRED','BLS','WB','IMF','NYFED','H15','TREASURY','COINGECKO')),
  id_value     text NOT NULL,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  -- an identifier value maps to at most one entity at any (valid_at, known_at): tickers are reused over time,
  -- so the valid range carries the reuse; the exclusion makes overlapping reuse impossible.
  EXCLUDE USING gist (id_type WITH =, id_value WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX identifier_xref_entity_idx ON identifier_xref (entity_kind, entity_id) WHERE tx_to = 'infinity';
CREATE INDEX identifier_xref_value_idx  ON identifier_xref (id_type, id_value) WHERE tx_to = 'infinity';
```

### 2.3 Exchanges, calendars, classifications, index membership (REF-06/07)

```sql
CREATE TABLE exchange (
  mic            char(4) PRIMARY KEY,
  operating_mic  char(4) NOT NULL,
  name           text NOT NULL,
  country        char(2) NOT NULL,
  timezone       text NOT NULL,                      -- 'America/New_York'
  calendar_id    text NOT NULL,                      -- 'NYSE','SIFMA','USGOVT','TARGET2','LSE'
  open_local     time NOT NULL, close_local time NOT NULL,
  exch_codes     text[] NOT NULL DEFAULT '{}'        -- OpenFIGI codes mapping to this MIC: {'UW'} → XNAS
);

CREATE TABLE calendar_holiday (
  calendar_id  text NOT NULL,
  hol_date     date NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'full' CHECK (kind IN ('full','early_close')),
  close_local  time,
  PRIMARY KEY (calendar_id, hol_date)
);
-- Seeded from packages/core/src/calendars (rule-generated 1990–2040); the table exists so that ad-hoc
-- closures (e.g. national days of mourning) can be added without a release; core merges both.

CREATE TABLE classification_scheme (id text PRIMARY KEY, name text NOT NULL);   -- GICS, SIC, NAICS, ICB, INTERNAL
CREATE TABLE classification_node (
  scheme_id   text NOT NULL REFERENCES classification_scheme(id),
  code        text NOT NULL,
  name        text NOT NULL,
  parent_code text,
  level       smallint NOT NULL,
  PRIMARY KEY (scheme_id, code)
);
CREATE TABLE instrument_classification (
  instrument_id char(12) NOT NULL,
  scheme_id     text NOT NULL,
  code          text NOT NULL,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (instrument_id WITH =, scheme_id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);

CREATE TABLE index_def (
  id                    text PRIMARY KEY,            -- 'SPX','NDX','RTY','INDU','VIX','UKX','DAX','NKY','HSI', ...
  instrument_id         char(12) NOT NULL,           -- the index instrument (asset_class 'index')
  name                  text NOT NULL,
  provider_id           text NOT NULL,               -- membership source adapter ('sec.nport', 'ssga.holdings', 'wiki.sp500')
  proxy_etf_instrument  char(12),                    -- SPY/IVV for SPX, QQQ for NDX, IWM for RTY
  weighting             text NOT NULL DEFAULT 'cap'  -- cap|price|equal
);
CREATE TABLE index_membership (
  index_id      text NOT NULL REFERENCES index_def(id),
  instrument_id char(12) NOT NULL,
  weight        numeric(12,9),                       -- fraction of index (0.0777 for NVDA)
  shares        numeric(20,4),
  source        text NOT NULL,                       -- 'sec.nport' | 'ssga.holdings' | 'wiki.sp500'
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (index_id WITH =, instrument_id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX index_membership_idx ON index_membership (index_id, valid_from, valid_to) WHERE tx_to = 'infinity';
```

Membership history: each weights snapshot (monthly N-PORT, daily SSGA) inserts versions with
`valid_from = as_of_date`; a constituent that disappears has its last version closed (`valid_to = as_of`),
so "members of SPX on 2024-03-15 as known on 2024-04-01" is `WHERE bt_at(..., '2024-03-15', '2024-04-01')`.

### 2.4 Terms & conditions (REF-04/05)

```sql
CREATE TABLE debt_terms (                            -- Treasuries populated in v1; columns cover REF-04 fully
  instrument_id      char(12) NOT NULL,
  issuer_kind        text NOT NULL CHECK (issuer_kind IN ('govt','agency','corp','muni')),
  sec_type           text NOT NULL CHECK (sec_type IN ('bill','note','bond','tips','frn','corp_fixed','corp_float','zero')),
  cusip              char(9),
  coupon             numeric(9,6),                   -- percent, NULL for bills
  coupon_type        text NOT NULL DEFAULT 'fixed' CHECK (coupon_type IN ('fixed','zero','float','step','inflation_linked')),
  coupon_freq        smallint NOT NULL DEFAULT 2,
  day_count          text NOT NULL DEFAULT 'ACT/ACT' CHECK (day_count IN ('ACT/ACT','ACT/360','ACT/365F','30/360','30E/360','ACT/ACT-ISDA')),
  bdc                text NOT NULL DEFAULT 'FOLLOWING' CHECK (bdc IN ('FOLLOWING','MODFOLLOWING','PRECEDING','NONE')),
  calendar_id        text NOT NULL DEFAULT 'SIFMA',
  issue_date         date, dated_date date, first_coupon_date date, maturity_date date NOT NULL,
  reference_index    text,                           -- 'SOFR' for FRNs
  spread_bp          numeric(9,4),
  index_ratio_base   numeric(12,8),                  -- TIPS
  call_schedule      jsonb NOT NULL DEFAULT '[]',    -- [{date, price, type:'call'|'put'|'make_whole', spread_bp}]
  sink_schedule      jsonb NOT NULL DEFAULT '[]',    -- [{date, amount_pct}]
  amortisation       jsonb NOT NULL DEFAULT '[]',
  seniority          text, collateral text, guarantors text[] NOT NULL DEFAULT '{}', covenants text,
  min_denomination   numeric(18,2), increment numeric(18,2),
  tenor_label        text,                           -- '4W','13W','2Y','10Y','30Y'
  on_the_run         boolean NOT NULL DEFAULT false,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX debt_terms_maturity_idx ON debt_terms (maturity_date) WHERE tx_to = 'infinity';

CREATE TABLE option_terms (
  instrument_id            char(12) NOT NULL,        -- minted TRM… id per contract (OpenFIGI mapping optional)
  underlying_instrument_id char(12) NOT NULL,
  occ_symbol               varchar(21) NOT NULL,     -- 'AAPL260916C00245000'
  root                     text NOT NULL,
  expiry                   date NOT NULL,
  strike                   numeric(14,4) NOT NULL,
  cp                       char(1) NOT NULL CHECK (cp IN ('C','P')),
  style                    text NOT NULL DEFAULT 'american' CHECK (style IN ('american','european')),
  multiplier               int NOT NULL DEFAULT 100,
  settlement               text NOT NULL DEFAULT 'physical' CHECK (settlement IN ('physical','cash')),
  exercise_cutoff_local    time NOT NULL DEFAULT '17:30',
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX option_terms_underlying_idx ON option_terms (underlying_instrument_id, expiry, strike) WHERE tx_to = 'infinity';
CREATE UNIQUE INDEX option_terms_occ_idx ON option_terms (occ_symbol) WHERE tx_to = 'infinity' AND valid_to = 'infinity';

CREATE TABLE future_terms (                          -- shape only in v1 (no futures source)
  instrument_id char(12) NOT NULL, underlying_instrument_id char(12), exchange_mic char(4),
  multiplier numeric(18,6), tick_size numeric(18,8), tick_value numeric(18,6),
  expiry date, first_notice_date date, last_trade_date date,
  settlement text CHECK (settlement IN ('physical','cash')), delivery_months text[], roll_convention jsonb,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  EXCLUDE USING gist (instrument_id WITH =, tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
```

### 2.5 Corporate actions (DATA-08, REF-09)

```sql
CREATE TABLE corporate_action (
  id             bigserial,
  instrument_id  char(12) NOT NULL,
  ca_type        ca_type NOT NULL,
  status         ca_status NOT NULL DEFAULT 'confirmed',
  announce_date  date, ex_date date NOT NULL, record_date date, pay_date date,
  amount         numeric(18,8),                      -- cash per share (dividend), currency below
  currency       char(3),
  ratio_num      numeric(18,8), ratio_den numeric(18,8),   -- split 4:1 → 4, 1 ; reverse 1:10 → 1, 10
  details        jsonb NOT NULL DEFAULT '{}',        -- spinoff child, merger terms, new ticker, ...
  source         text NOT NULL,                      -- 'yahoo.events' | 'sec.8k' | 'manual'
  review_state   text NOT NULL DEFAULT 'auto' CHECK (review_state IN ('auto','queued','reviewed','rejected')), -- REF-10 exception queue
  reviewed_by    uuid, reviewed_at timestamptz,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL DEFAULT 'infinity',
  tx_from timestamptz NOT NULL DEFAULT now(), tx_to timestamptz NOT NULL DEFAULT 'infinity',
  prov_id bigint NOT NULL REFERENCES provenance(id),
  CHECK (valid_from < valid_to), CHECK (tx_from < tx_to),
  EXCLUDE USING gist (instrument_id WITH =, ca_type WITH =, ex_date WITH =, source WITH =,
                      tstzrange(valid_from, valid_to,'[)') WITH &&, tstzrange(tx_from, tx_to,'[)') WITH &&)
);
CREATE INDEX corporate_action_lookup_idx ON corporate_action (instrument_id, ex_date) WHERE tx_to = 'infinity';
```

Adjustment on read (policy parameter of every historical request, `adjust: 'none'|'split'|'split_div'|'total_return'`)
is computed by `core/analytics/adjust.ts`:

* `split`: cumulative factor `F(d) = Π ratio_den/ratio_num` over splits with `ex_date > d`; price × F, volume ÷ F.
* `split_div`: additionally `× Π (1 − amount / close(ex_date − 1 trading day))` over cash dividends with `ex_date > d` (CRSP convention).
* `total_return`: index series `TR(d) = TR(d−1) × (close(d) + div(d)) / close(d−1)` with `TR(start) = close(start)` (dividends reinvested at ex-date close).
* Only `status IN ('confirmed','announced')` actions are applied; `estimated` ones are shown on CACS but never applied.

## 3. Time series (`0003`)

### 3.1 Partitioning on plain Postgres 14

Declarative range partitioning; partitions are created by `packages/server/src/db/partitions.ts`
(`ensurePartitions(table, from, to)`), called at migration time for the seed window and by the scheduler
daily (`partitions.roll` job) 14 days ahead. Every partitioned table has a `DEFAULT` partition so an
unexpected date never fails an insert (a `dq` check alarms when the default partition is non-empty).
Retention: the same job detaches and drops partitions older than `licence_registry.retention_days` for the
table's provider (STOR-07), logging to `ingest_run`.

| Table | Partition key | Granularity | Naming |
| --- | --- | --- | --- |
| `bar_daily` | `bar_date` | yearly | `bar_daily_y2026` |
| `bar_intraday` | `bar_ts` | monthly | `bar_intraday_m2026_09` |
| `tick` | `ts` | daily | `tick_d2026_09_15` |
| `option_chain_snapshot` | `captured_at` | monthly | `option_chain_snapshot_m2026_09` |
| `access_log` | `ts` | monthly | `access_log_m2026_09` |
| `usage_event` | `ts` | monthly | `usage_event_m2026_09` |

```sql
CREATE TABLE bar_daily (
  instrument_id  char(12) NOT NULL,
  bar_date       date NOT NULL,
  open numeric(18,6), high numeric(18,6), low numeric(18,6), close numeric(18,6) NOT NULL,
  volume         bigint,
  src_adj_close  numeric(18,6),                      -- Yahoo adjclose, informational only (never served)
  vwap           numeric(18,6),
  source         text NOT NULL,                      -- 'yahoo.chart' | 'stooq.daily' | 'cboe.eod'
  prov_id        bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (instrument_id, bar_date)
) PARTITION BY RANGE (bar_date);
CREATE TABLE bar_daily_default PARTITION OF bar_daily DEFAULT;
-- yearly partitions 1962..2030 created by partitions.ts (FRED DGS10 starts 1962)

CREATE TABLE bar_intraday (
  instrument_id  char(12) NOT NULL,
  bar_interval   text NOT NULL CHECK (bar_interval IN ('1m','5m','15m','1h')),
  bar_ts         timestamptz NOT NULL,               -- bar start, exchange session time converted to UTC
  open numeric(18,6), high numeric(18,6), low numeric(18,6), close numeric(18,6) NOT NULL,
  volume         bigint,
  session        text NOT NULL DEFAULT 'regular' CHECK (session IN ('pre','regular','post')),
  source         text NOT NULL,
  prov_id        bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (instrument_id, bar_interval, bar_ts)
) PARTITION BY RANGE (bar_ts);
CREATE TABLE bar_intraday_default PARTITION OF bar_intraday DEFAULT;

CREATE TABLE tick (                                  -- STOR-01 analogue; HTTP polling yields quote/trade "ticks"
  instrument_id char(12) NOT NULL,
  ts            timestamptz NOT NULL,                -- src ts when present, else cap
  seq           bigint NOT NULL,                     -- provider seqno (Cboe) or capture counter
  kind          text NOT NULL CHECK (kind IN ('trade','quote','bar')),
  price numeric(18,6), size bigint,
  bid numeric(18,6), ask numeric(18,6), bid_size int, ask_size int,
  conditions    text[] NOT NULL DEFAULT '{}',        -- FEED-07 placeholder: 'regular','delayed','synthetic_from_poll'
  src_ts timestamptz, cap_ts timestamptz NOT NULL, pub_ts timestamptz NOT NULL,   -- FEED-05
  prov_id       bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (instrument_id, ts, seq)
) PARTITION BY RANGE (ts);
CREATE TABLE tick_default PARTITION OF tick DEFAULT;

CREATE TABLE eod_snapshot (                          -- serves the 'eod' tier and the missing-close check
  instrument_id char(12) NOT NULL,
  session_date  date NOT NULL,
  fields        jsonb NOT NULL,                      -- full Composite.fields at session close
  close_ts      timestamptz NOT NULL,
  prov_id       bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (instrument_id, session_date)
);

CREATE TABLE option_chain_snapshot (
  underlying_instrument_id char(12) NOT NULL,
  captured_at              timestamptz NOT NULL,
  option_instrument_id     char(12) NOT NULL,
  bid numeric(14,4), ask numeric(14,4), bid_size int, ask_size int,
  last numeric(14,4), volume int, open_interest int,
  iv numeric(10,6), delta numeric(10,6), gamma numeric(12,8), vega numeric(12,6), theta numeric(12,6), rho numeric(12,6),
  theo numeric(14,6), prev_close numeric(14,6), src_last_trade_ts timestamptz,
  prov_id bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (underlying_instrument_id, captured_at, option_instrument_id)
) PARTITION BY RANGE (captured_at);
CREATE TABLE option_chain_snapshot_default PARTITION OF option_chain_snapshot DEFAULT;

CREATE TABLE vol_surface (                           -- ANAL-04 historical surface storage
  underlying_instrument_id char(12) NOT NULL,
  as_of          timestamptz NOT NULL,
  expiry         date NOT NULL,
  forward        numeric(18,6) NOT NULL,
  atm_iv         numeric(10,6),
  svi            jsonb NOT NULL,                     -- {a,b,rho,m,sigma, rmse, n}
  engine_version text NOT NULL,
  prov_ids       bigint[] NOT NULL,
  PRIMARY KEY (underlying_instrument_id, as_of, expiry)
);

CREATE TABLE short_interest (
  instrument_id char(12) NOT NULL, settlement_date date NOT NULL,
  short_qty bigint, prev_short_qty bigint, adv bigint, days_to_cover numeric(10,2), change_pct numeric(10,4),
  prov_id bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (instrument_id, settlement_date)
);

CREATE TABLE holder (                                -- HDS: ETF holders (N-PORT / issuer files); 13F where feasible
  instrument_id  char(12) NOT NULL,                  -- held security
  holder_kind    text NOT NULL CHECK (holder_kind IN ('etf','13f')),
  holder_id      text NOT NULL,                      -- ETF instrument id, or 13F filer CIK
  as_of_date     date NOT NULL,
  shares numeric(20,4), value_usd numeric(20,2), pct_of_holder numeric(12,9),
  prov_id bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (instrument_id, holder_kind, holder_id, as_of_date)
);

CREATE TABLE fx_ref_rate (                           -- ECB reference rates via frankfurter; used for currency conversion
  base char(3) NOT NULL, quote char(3) NOT NULL, as_of_date date NOT NULL, rate numeric(18,8) NOT NULL,
  prov_id bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (base, quote, as_of_date)
);
```

Indexes: `bar_daily (instrument_id, bar_date DESC)` is the PK; `bar_intraday (instrument_id, bar_ts DESC)`
via PK prefix; `tick (instrument_id, ts)` via PK; additional `tick_kind_idx ON tick (instrument_id, kind, ts)`;
`option_chain_snapshot_latest_idx ON option_chain_snapshot (underlying_instrument_id, captured_at DESC)`.

### 3.2 Query budgets these support

* 1 year of daily bars for one instrument: PK range scan on one or two yearly partitions, ~252 rows → < 5 ms
  DB time; budget 200 ms end-to-end including adjustment (NFR table).
* One session of ticks for one name: single daily partition, PK range scan; ~1,600 rows (15 s polling) → well
  inside 2 s.

### 3.3 The historical read path (single implementation)

`data/historical.ts`: `getBars({instrumentId, start, end, periodicity, adjust, currency, fill}, asOf)`
→ SQL for `bar_daily` rows (+ preceding row for returns) → `corporate_action` current versions as of
`knownAt` → `adjust.factors(actions, policy)` → apply → resample to `W/M/Q/Y` (last close, sum volume,
max high, min low, first open) using the instrument's exchange calendar → optional FX conversion through
`fx_ref_rate` (same-date rate, `prev` fill) → rows with `prov_ids`. HP, GP, stats engines, PORT, RV and the
`/api/v1/data` historical request all call this one function.

## 4. Fundamentals, filings and economics (`0004`)

```sql
CREATE TABLE filing (
  accn            text PRIMARY KEY,                  -- '0000320193-26-000020'
  cik             int NOT NULL,
  form            text NOT NULL,                     -- '10-K','10-Q','8-K','4','NPORT-P', ...
  filing_date     date NOT NULL,
  report_date     date,
  acceptance_ts   timestamptz,
  items           text[] NOT NULL DEFAULT '{}',      -- 8-K items '2.02','5.02',...
  primary_doc     text, primary_doc_desc text,
  is_xbrl         boolean NOT NULL DEFAULT false, is_inline_xbrl boolean NOT NULL DEFAULT false,
  size_bytes      int,
  url             text NOT NULL,
  prov_id         bigint NOT NULL REFERENCES provenance(id)
);
CREATE INDEX filing_cik_date_idx ON filing (cik, filing_date DESC);
CREATE INDEX filing_form_date_idx ON filing (form, filing_date DESC);

CREATE TABLE fundamental_fact (                      -- point-in-time keyed on filed_at (STOR-06)
  id            bigserial PRIMARY KEY,
  cik           int NOT NULL,
  taxonomy      text NOT NULL,                       -- 'us-gaap' | 'dei' | 'ifrs-full'
  concept       text NOT NULL,                       -- 'RevenueFromContractWithCustomerExcludingAssessedTax'
  unit          text NOT NULL,                       -- 'USD' | 'shares' | 'USD/shares' | 'pure'
  period_start  date,                                -- NULL for instant (balance-sheet) facts
  period_end    date NOT NULL,
  val           numeric(28,6) NOT NULL,
  accn          text NOT NULL,
  fy            smallint, fp text,                   -- 'FY','Q1','Q2','Q3'
  form          text NOT NULL,
  filed_at      date NOT NULL,                       -- the point-in-time key
  frame         text,                                -- 'CY2026Q2', 'CY2016', 'CY2009Q2I' (NULL when SEC omits)
  prov_id       bigint NOT NULL REFERENCES provenance(id),
  UNIQUE (cik, taxonomy, concept, unit, period_start, period_end, accn)
);
CREATE INDEX fundamental_fact_pit_idx ON fundamental_fact (cik, concept, period_end DESC, filed_at);
CREATE INDEX fundamental_fact_frame_idx ON fundamental_fact (concept, frame) WHERE frame IS NOT NULL;

-- Point-in-time read (the only read path, data/fundamentals.ts):
--   SELECT DISTINCT ON (concept, period_end, period_start) ... WHERE cik=$1 AND concept = ANY($2)
--   AND filed_at <= $known_at ORDER BY concept, period_end, period_start, filed_at DESC, accn DESC
-- i.e. the latest filing known at known_at wins; restatements filed later are invisible to earlier known_at.

CREATE TABLE fa_line_map (                           -- standardisation (DATA-06): line item → concept priority list
  line_id       text PRIMARY KEY,                    -- 'REVENUE','COGS','GROSS_PROFIT','OPER_INCOME','NET_INCOME','EPS_DILUTED',
                                                     -- 'TOTAL_ASSETS','TOTAL_LIABILITIES','TOTAL_EQUITY','CASH','DEBT_LT','CFO','CAPEX','FCF','SHARES_DILUTED', ...
  statement     text NOT NULL CHECK (statement IN ('IS','BS','CF','RATIO')),
  label         text NOT NULL,
  concepts      text[] NOT NULL,                     -- in priority order, e.g. {'Revenues','RevenueFromContractWithCustomerExcludingAssessedTax','SalesRevenueNet'}
  unit          text NOT NULL,
  derivation    text,                                -- formula over other line_ids for RATIO/derived lines, e.g. 'CFO - CAPEX'
  sort_order    int NOT NULL
);

CREATE TABLE econ_series (
  id                 text PRIMARY KEY,               -- 'FRED:CPIAUCSL', 'BLS:CUUR0000SA0', 'WB:USA:NY.GDP.MKTP.CD', 'IMF:USA:NGDP_RPCH', 'H15:RIFLGFCY10_N.B'
  provider_id        text NOT NULL REFERENCES licence_registry(provider_id),
  provider_series_id text NOT NULL,
  instrument_id      char(12) NOT NULL,              -- econ instrument (asset_class 'econ') so the command line can address it
  name               text NOT NULL,
  units              text, frequency char(1) NOT NULL CHECK (frequency IN ('D','W','M','Q','A')),
  seasonal_adj       boolean, country char(3), category text,
  release_id         text,                           -- REFERENCES econ_release(id)
  prov_id            bigint NOT NULL REFERENCES provenance(id)
);

CREATE TABLE econ_observation (                      -- revisions kept as vintages
  series_id    text NOT NULL REFERENCES econ_series(id),
  period_date  date NOT NULL,                        -- period start (monthly: first of month)
  vintage_at   timestamptz NOT NULL,                 -- when this value became known to us (capture time)
  value        numeric(28,8),                        -- NULL when the source marks it missing ('.' FRED, '-' BLS, 'ND' H.15)
  status       text NOT NULL DEFAULT 'final' CHECK (status IN ('final','preliminary','missing')),
  footnote     text,
  is_latest    boolean NOT NULL DEFAULT true,        -- maintained by the ingest upsert (one latest per period)
  prov_id      bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (series_id, period_date, vintage_at)
);
CREATE INDEX econ_observation_latest_idx ON econ_observation (series_id, period_date DESC) WHERE is_latest;

CREATE TABLE econ_release (
  id           text PRIMARY KEY,                     -- 'FRED:10' (CPI), 'BLS:cpi', 'BLS:empsit', 'FOMC'
  name         text NOT NULL,
  provider_id  text NOT NULL,
  country      char(3) NOT NULL DEFAULT 'USA',
  frequency    char(1),
  url          text
);
CREATE TABLE econ_release_event (                    -- ECO calendar rows
  id             bigserial PRIMARY KEY,
  release_id     text NOT NULL REFERENCES econ_release(id),
  scheduled_at   timestamptz NOT NULL,
  period_label   text,                               -- 'Aug 2026'
  series_id      text REFERENCES econ_series(id),   -- headline series, when known
  actual         numeric(28,8), prior numeric(28,8), revised_prior numeric(28,8),
  consensus      numeric(28,8),                      -- always NULL in v1 (no consensus source)
  consensus_reason text NOT NULL DEFAULT 'NO_SOURCE',
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','released','revised')),
  prov_id        bigint NOT NULL REFERENCES provenance(id),
  UNIQUE (release_id, scheduled_at)
);
CREATE INDEX econ_release_event_time_idx ON econ_release_event (scheduled_at);

CREATE TABLE rate_fixing (                           -- NY Fed / H.15 fixings
  rate_id        text NOT NULL,                      -- 'SOFR','EFFR','OBFR','TGCR','BGCR','SOFRAI','H15:RIFLGFCY10_N.B'
  effective_date date NOT NULL,
  vintage_at     timestamptz NOT NULL,               -- revisions (revisionIndicator) create a new vintage
  rate           numeric(10,6),
  pct1 numeric(10,6), pct25 numeric(10,6), pct75 numeric(10,6), pct99 numeric(10,6),
  volume_bn      numeric(14,2),
  target_from numeric(8,4), target_to numeric(8,4),  -- EFFR only
  avg30 numeric(10,6), avg90 numeric(10,6), avg180 numeric(10,6), index_value numeric(16,10),  -- SOFRAI
  revision_indicator text,
  is_latest      boolean NOT NULL DEFAULT true,
  prov_id        bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (rate_id, effective_date, vintage_at)
);
```

## 5. News, entities, curves (`0005`)

```sql
CREATE TABLE topic (
  id        text PRIMARY KEY,                        -- 'FED','INFLATION','AI','ENERGY','M&A','EARNINGS', GICS sector ids
  name      text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('sector','theme','region','event','release')),
  keywords  text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE person (                                -- directory for autocomplete (people) and MSG-01
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL, role text, firm text,
  source    text NOT NULL CHECK (source IN ('directory','sec_officer','author')),
  user_id   uuid,                                    -- when the person is a platform user
  aliases   text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX person_name_trgm_idx ON person USING gin (name gin_trgm_ops);

CREATE TABLE news_item (
  id                 bigserial PRIMARY KEY,
  source             text NOT NULL,                  -- 'bbg.rss' | 'sec.8k' | 'fed.press'
  feed               text NOT NULL,                  -- 'markets','economics','politics','technology','wealth','industries','8-K','press_all'
  external_id        text NOT NULL,                  -- RSS guid ('TLEUW0KGZAKZ00'), SEC accession, Fed URL
  headline           text NOT NULL,
  summary            text,
  url                text NOT NULL,
  author             text,
  published_at       timestamptz NOT NULL,           -- src
  captured_at        timestamptz NOT NULL,           -- cap
  lang               char(2) NOT NULL DEFAULT 'en',
  machine_generated  boolean NOT NULL DEFAULT false, -- NEWS-08
  tsv                tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(headline,'') || ' ' || coalesce(summary,''))) STORED,
  prov_id            bigint NOT NULL REFERENCES provenance(id),
  UNIQUE (source, external_id)
);
CREATE INDEX news_item_published_idx ON news_item (published_at DESC);
CREATE INDEX news_item_tsv_idx ON news_item USING gin (tsv);
CREATE INDEX news_item_headline_trgm_idx ON news_item USING gin (headline gin_trgm_ops);

CREATE TABLE news_entity_link (                      -- NEWS-02, precision first
  news_id      bigint NOT NULL REFERENCES news_item(id) ON DELETE CASCADE,
  entity_kind  text NOT NULL CHECK (entity_kind IN ('instrument','issuer','person','topic','release')),
  entity_id    text NOT NULL,
  confidence   real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  method       text NOT NULL CHECK (method IN ('cik','ticker_exact','issuer_name_exact','issuer_name_alias','keyword','manual')),
  PRIMARY KEY (news_id, entity_kind, entity_id)
);
CREATE INDEX news_entity_link_entity_idx ON news_entity_link (entity_kind, entity_id, news_id DESC);

CREATE TABLE curve_def (
  id             text PRIMARY KEY,                   -- 'UST_PAR','UST_BILL','UST_CMT','SOFR_OIS','SOFR_FIX'
  name           text NOT NULL,
  currency       char(3) NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('par','bill','cmt','ois','zero','discount')),
  provider_id    text NOT NULL,
  interpolation  text NOT NULL DEFAULT 'monotone_convex' CHECK (interpolation IN ('linear_zero','loglinear_df','monotone_convex')),
  day_count      text NOT NULL DEFAULT 'ACT/360'
);
CREATE TABLE curve_point (
  curve_id     text NOT NULL REFERENCES curve_def(id),
  as_of_date   date NOT NULL,
  tenor        text NOT NULL,                        -- '1M','1.5M','2M','3M','4M','6M','1Y','2Y','3Y','5Y','7Y','10Y','20Y','30Y' ; bills '4W'...'52W'
  tenor_days   int  NOT NULL,
  value        numeric(12,8) NOT NULL,               -- percent
  aux          jsonb NOT NULL DEFAULT '{}',          -- bills: {discount, bey, maturity_date}
  prov_id      bigint NOT NULL REFERENCES provenance(id),
  PRIMARY KEY (curve_id, as_of_date, tenor)
);
CREATE TABLE curve_build (                           -- stored bootstrap results (ANAL-08: inputs + engine version)
  id             bigserial PRIMARY KEY,
  curve_id       text NOT NULL REFERENCES curve_def(id),
  as_of_date     date NOT NULL,
  valuation_ts   timestamptz NOT NULL,
  engine_version text NOT NULL,
  inputs         jsonb NOT NULL,                     -- the exact points + settings used
  outputs        jsonb NOT NULL,                     -- {nodes:[{t, df, zero, fwd}], interpolation}
  prov_ids       bigint[] NOT NULL,
  built_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (curve_id, as_of_date, engine_version)
);
```

## 6. Users, firms, sessions, entitlements, access log (`0006`)

```sql
CREATE TABLE firm (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  seat_count  int NOT NULL DEFAULT 1,
  contract    jsonb NOT NULL DEFAULT '{}',            -- {tiers:{equity:'delayed',govt:'delayed',...}, api:true, export:true}
  data_residency text NOT NULL DEFAULT 'us',          -- REG-07 (recorded, single region in v1)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_user (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL REFERENCES firm(id),
  email               text NOT NULL,
  display_name        text NOT NULL,
  role                text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','compliance','dataops')),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','deprovisioned')),
  desk                text,
  sanctions_screened_at timestamptz,                  -- REG-06 mechanism
  pii_basis           jsonb NOT NULL DEFAULT '{}',    -- REG-04: lawful basis per field {email:'contract', ...}
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_login_at       timestamptz
);
CREATE UNIQUE INDEX app_user_email_idx ON app_user (lower(email));

CREATE TABLE user_credential (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  kind             text NOT NULL CHECK (kind IN ('password','webauthn')),
  password_hash    text,                             -- argon2id
  credential_id    bytea, public_key bytea, sign_count bigint, transports text[], aaguid uuid,
  created_at       timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz,
  UNIQUE (credential_id)
);
CREATE TABLE session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  kind          text NOT NULL CHECK (kind IN ('web','api')),
  token_hash    bytea NOT NULL UNIQUE,               -- sha256 of the opaque token
  device_id     text NOT NULL,                       -- client-generated stable id (localStorage) or API key id
  device_label  text, ip inet, user_agent text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz, revoked_reason text,    -- 'logout','takeover','admin','expired'
  restricted    boolean NOT NULL DEFAULT false       -- concurrent-session restriction (ENTL-03/SEC-03)
);
CREATE INDEX session_user_active_idx ON session (user_id) WHERE revoked_at IS NULL;

CREATE TABLE api_key (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  key_hash    bytea NOT NULL UNIQUE,
  label       text NOT NULL,
  scopes      text[] NOT NULL DEFAULT '{data:read,fn:run}',
  created_at  timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, last_used_at timestamptz
);

CREATE TABLE entitlement (                           -- intersection is computed in evaluate.ts (ENTL-02)
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind  text NOT NULL CHECK (subject_kind IN ('user','firm')),
  subject_id    uuid NOT NULL,
  asset_class   asset_class,                          -- NULL = all
  field_class   text CHECK (field_class IN ('price','book','reference','fundamentals','news','econ','derived','holdings')),  -- NULL = all
  tier          data_tier NOT NULL DEFAULT 'delayed',
  usage_types   usage_type[] NOT NULL DEFAULT '{display,export,api}',
  valid_from    timestamptz NOT NULL DEFAULT now(), valid_to timestamptz NOT NULL DEFAULT 'infinity',
  granted_by    uuid, note text
);
CREATE INDEX entitlement_subject_idx ON entitlement (subject_kind, subject_id);

CREATE TABLE access_log (                            -- ENTL-04; batched async writes
  id            bigserial,
  ts            timestamptz NOT NULL,
  user_id       uuid NOT NULL,
  firm_id       uuid NOT NULL,
  session_id    uuid,
  instrument_id char(12),
  field_class   text NOT NULL,
  field_id      text,
  tier          data_tier NOT NULL,                  -- granted tier
  requested_tier data_tier NOT NULL,
  usage         usage_type NOT NULL,
  purpose       text NOT NULL,                       -- 'fn:GP', 'ws:sub', 'api:data', 'export:HP'
  provider_id   text NOT NULL,
  licence_id    text NOT NULL,
  reason        text NOT NULL DEFAULT 'OK',          -- DowngradeReason
  trace_id      text,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE TABLE access_log_default PARTITION OF access_log DEFAULT;
CREATE INDEX access_log_user_ts_idx ON access_log (user_id, ts);
CREATE INDEX access_log_licence_ts_idx ON access_log (licence_id, ts);

CREATE TABLE usage_event (                           -- FUNC-04
  id          bigserial,
  ts          timestamptz NOT NULL,
  user_id     uuid NOT NULL, session_id uuid, panel smallint,
  kind        text NOT NULL,                         -- 'fn.launch','fn.param','fn.export','search.select','ws.subscribe','help.open','ticket.open','cmd.error'
  fn_code     text, params_hash text, security_id char(12),
  duration_ms int, trace_id text,
  details     jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE TABLE usage_event_default PARTITION OF usage_event DEFAULT;
CREATE INDEX usage_event_kind_ts_idx ON usage_event (kind, ts);

CREATE TABLE quota_counter (                         -- API-06
  user_id      uuid NOT NULL,
  window_kind  text NOT NULL CHECK (window_kind IN ('day','month')),
  window_start date NOT NULL,
  metric       text NOT NULL CHECK (metric IN ('unique_securities','datapoints','concurrent_subs')),
  value        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_kind, window_start, metric)
);
CREATE TABLE quota_unique_security (
  user_id uuid NOT NULL, day date NOT NULL, instrument_id char(12) NOT NULL,
  PRIMARY KEY (user_id, day, instrument_id)
);
```

## 7. Workspaces, watchlists, portfolios, messaging, alerts (`0007`)

```sql
CREATE TABLE workspace (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  name        text NOT NULL DEFAULT 'Default',
  is_active   boolean NOT NULL DEFAULT true,
  layout      jsonb NOT NULL,                        -- WorkspaceLayout (CLIENT.md §6): panels, monitors, chart settings
  version     int NOT NULL DEFAULT 1,                -- optimistic concurrency; PUT must send the version it read
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspace_active_idx ON workspace (user_id) WHERE is_active;

CREATE TABLE watchlist (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL REFERENCES app_user(id),
  firm_id        uuid NOT NULL REFERENCES firm(id),
  name           text NOT NULL,
  visibility     text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','firm')),
  columns        jsonb NOT NULL,                     -- [{id:'PX_LAST'} | {id:'c1', formula:'PX_LAST/PX_PREV_CLOSE-1', label:'Chg'}]
  sort           jsonb NOT NULL DEFAULT '[]',
  group_by       text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE watchlist_item (
  watchlist_id  uuid NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
  instrument_id char(12) NOT NULL,
  position      int NOT NULL,
  note          text,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, instrument_id)
);

CREATE TABLE portfolio (                             -- PORT-07: RLS-protected (see §9)
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL REFERENCES firm(id),
  owner_user_id    uuid NOT NULL REFERENCES app_user(id),
  name             text NOT NULL,
  base_currency    char(3) NOT NULL DEFAULT 'USD',
  benchmark_index  text REFERENCES index_def(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE position (
  id             bigserial PRIMARY KEY,
  portfolio_id   uuid NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  firm_id        uuid NOT NULL,                       -- denormalised for RLS
  instrument_id  char(12),                            -- NULL for cash lines
  cash_currency  char(3),
  lot_id         text NOT NULL,
  quantity       numeric(24,8) NOT NULL,
  cost_price     numeric(18,6), cost_currency char(3),
  trade_date     date, settle_date date,
  accrued        numeric(18,6) NOT NULL DEFAULT 0,
  as_of_date     date NOT NULL,
  source         text NOT NULL CHECK (source IN ('upload','api','manual')),
  UNIQUE (portfolio_id, lot_id, as_of_date)
);
CREATE TABLE portfolio_import (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id  uuid NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  firm_id       uuid NOT NULL,
  uploaded_by   uuid NOT NULL,
  filename      text NOT NULL, rows int NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('parsed','reconciled','failed')),
  errors        jsonb NOT NULL DEFAULT '[]',          -- [{row, column, message, value}]
  reconciliation jsonb NOT NULL DEFAULT '{}',         -- {matched, added, removed, quantityDiffs:[...]}
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('dm','group')),
  name           text,
  scope          text NOT NULL DEFAULT 'internal' CHECK (scope IN ('internal','external')),
  created_by     uuid NOT NULL REFERENCES app_user(id),
  retention_days int NOT NULL DEFAULT 2557,           -- 7 years (MSG-03 / REG-01)
  disclaimer     text,
  wall_tag       text,                                -- ethical wall group; members must share it (MSG-03/SEC-06)
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE room_member (
  room_id uuid NOT NULL REFERENCES room(id), user_id uuid NOT NULL REFERENCES app_user(id),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner','compliance')),
  joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE message (                               -- append-only (trigger in §9); hash-chained per room (MSG-02 mechanism)
  id             bigserial PRIMARY KEY,
  room_id        uuid NOT NULL REFERENCES room(id),
  sender_user_id uuid NOT NULL REFERENCES app_user(id),
  sent_at        timestamptz NOT NULL DEFAULT now(),
  body           text NOT NULL,
  shares         jsonb NOT NULL DEFAULT '[]',         -- MSG-04: [{kind:'security'|'chart'|'function'|'portfolio'|'watchlist', ref:{...}}]
  structured     jsonb,                               -- MSG-06 shape: {type:'rfq'|'ioi', side, instrumentId, qty, price, ...}
  prev_hash      bytea, hash bytea NOT NULL,          -- sha256(prev_hash || room_id || sender || sent_at || body || shares)
  trace_id       text
);
CREATE INDEX message_room_idx ON message (room_id, sent_at DESC);
CREATE TABLE message_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid REFERENCES room(id), message_id bigint REFERENCES message(id),
  kind text NOT NULL CHECK (kind IN ('legal_hold','supervisory_review')),
  placed_by uuid NOT NULL, placed_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz, note text
);
CREATE TABLE surveillance_lexicon (id serial PRIMARY KEY, term text NOT NULL, severity smallint NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true);
CREATE TABLE surveillance_hit (
  message_id bigint NOT NULL REFERENCES message(id), lexicon_id int NOT NULL REFERENCES surveillance_lexicon(id),
  matched_text text NOT NULL, reviewed_by uuid, reviewed_at timestamptz,
  disposition text CHECK (disposition IN ('cleared','escalated')),
  PRIMARY KEY (message_id, lexicon_id)
);

CREATE TABLE alert (                                 -- NEWS-07
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  kind          text NOT NULL CHECK (kind IN ('price','news','filing','calendar')),
  spec          jsonb NOT NULL,                       -- price: {instrumentId, field, op:'>'|'<'|'crosses', value} ; news: {savedSearchId} ; filing: {cik, forms[]} ; calendar: {releaseId, minutesBefore}
  delivery      text[] NOT NULL DEFAULT '{inapp}',    -- 'inapp' | 'email' | 'push'
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(), last_fired_at timestamptz
);
CREATE TABLE alert_event (
  id bigserial PRIMARY KEY, alert_id uuid NOT NULL REFERENCES alert(id) ON DELETE CASCADE,
  fired_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL, delivered jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE saved_search (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_user(id),
  kind text NOT NULL CHECK (kind IN ('news','eqs','srch')), name text NOT NULL, query jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE annotation (                            -- CHRT-05
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL REFERENCES app_user(id),
  instrument_id  char(12) NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('trendline','hline','vline','fib','text','regression','rect')),
  anchors        jsonb NOT NULL,                      -- [{t: epoch_ms, v: number}] data coordinates
  style          jsonb NOT NULL DEFAULT '{}',
  visibility     text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','firm','users')),
  shared_with    uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX annotation_instrument_idx ON annotation (instrument_id);
CREATE TABLE support_ticket (                        -- TERM-09 second HELP press
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_user(id),
  panel smallint, fn_code text, security_id char(12), trace_id text,
  question text NOT NULL, screen_state jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## 8. Operations (`0008`)

```sql
CREATE TABLE ingest_job (
  id          text PRIMARY KEY,                      -- 'cboe.quotes.hot', 'yahoo.daily.universe', ...
  provider_id text NOT NULL REFERENCES licence_registry(provider_id),
  schedule    text NOT NULL,                         -- cron expression or 'every:15s'
  enabled     boolean NOT NULL DEFAULT true,
  config      jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE ingest_run (
  id bigserial PRIMARY KEY, job_id text NOT NULL REFERENCES ingest_job(id),
  started_at timestamptz NOT NULL, finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','ok','error','skipped')),
  records int NOT NULL DEFAULT 0, error text,
  prov_from bigint, prov_to bigint, trace_id text
);
CREATE INDEX ingest_run_job_idx ON ingest_run (job_id, started_at DESC);

CREATE TABLE dq_check (id text PRIMARY KEY, name text NOT NULL, severity text NOT NULL CHECK (severity IN ('info','warn','critical')), description text NOT NULL);
CREATE TABLE dq_result (
  id bigserial PRIMARY KEY, check_id text NOT NULL REFERENCES dq_check(id),
  ts timestamptz NOT NULL DEFAULT now(), subject text NOT NULL,
  value numeric, threshold numeric, status text NOT NULL CHECK (status IN ('ok','warn','fail')),
  details jsonb NOT NULL DEFAULT '{}', resolved_at timestamptz
);
CREATE INDEX dq_result_open_idx ON dq_result (check_id, ts DESC) WHERE resolved_at IS NULL;
```

## 9. Row-level security and immutability triggers (`0010`)

```sql
-- Tenant isolation for client data (PORT-07, SEC-05). The server sets these per transaction:
--   SET LOCAL app.user_id = '<uuid>'; SET LOCAL app.firm_id = '<uuid>'; SET LOCAL app.role = 'user'|'admin'|'compliance'
ALTER TABLE portfolio        ENABLE ROW LEVEL SECURITY;
ALTER TABLE position         ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio        FORCE ROW LEVEL SECURITY;   -- applies to the table owner too
ALTER TABLE position         FORCE ROW LEVEL SECURITY;
ALTER TABLE portfolio_import FORCE ROW LEVEL SECURITY;
CREATE POLICY portfolio_tenant ON portfolio USING (firm_id = current_setting('app.firm_id', true)::uuid)
  WITH CHECK (firm_id = current_setting('app.firm_id', true)::uuid);
CREATE POLICY position_tenant ON position USING (firm_id = current_setting('app.firm_id', true)::uuid)
  WITH CHECK (firm_id = current_setting('app.firm_id', true)::uuid);
CREATE POLICY portfolio_import_tenant ON portfolio_import USING (firm_id = current_setting('app.firm_id', true)::uuid)
  WITH CHECK (firm_id = current_setting('app.firm_id', true)::uuid);
-- News/data-ops roles never receive app.firm_id (SEC-06: the news pipeline runs with role 'ingest', which
-- has no grants on portfolio*, watchlist*, room*, message*).
REVOKE ALL ON portfolio, position, portfolio_import, watchlist, watchlist_item, room, room_member, message FROM ingest_role;

-- Messages are append-only (MSG-02 / REG-01 mechanism)
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER message_immutable BEFORE UPDATE OR DELETE ON message FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER access_log_immutable BEFORE UPDATE OR DELETE ON access_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER provenance_immutable BEFORE UPDATE OR DELETE ON provenance FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Hash chain per room
CREATE FUNCTION message_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev bytea;
BEGIN
  SELECT hash INTO prev FROM message WHERE room_id = NEW.room_id ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := digest(coalesce(prev,'\x'::bytea) || NEW.room_id::text::bytea || NEW.sender_user_id::text::bytea
                     || NEW.sent_at::text::bytea || convert_to(NEW.body,'UTF8') || convert_to(NEW.shares::text,'UTF8'), 'sha256');
  RETURN NEW;
END $$;
CREATE TRIGGER message_chain_trg BEFORE INSERT ON message FOR EACH ROW EXECUTE FUNCTION message_chain();

CREATE TRIGGER workspace_updated BEFORE UPDATE ON workspace FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER watchlist_updated BEFORE UPDATE ON watchlist FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER portfolio_updated BEFORE UPDATE ON portfolio FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER annotation_updated BEFORE UPDATE ON annotation FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

## 10. Index summary (`0009`) — hot paths

| Path | Index |
| --- | --- |
| Command line resolve `AAPL US Equity` | `instrument_ticker_idx (upper(ticker), market_sector)` partial current; `identifier_xref_value_idx` |
| Autocomplete by name (server fallback) | `instrument_name_trgm_idx`, `issuer_name_trgm_idx`, `person_name_trgm_idx` (`similarity() > 0.3`) |
| HP / GP daily | `bar_daily` PK, yearly partitions |
| GIP intraday | `bar_intraday` PK, monthly partitions |
| Q/QM ticks | `tick` PK daily partitions, `tick_kind_idx` |
| FA / EE point-in-time | `fundamental_fact_pit_idx (cik, concept, period_end DESC, filed_at)` |
| N / TOP / CN | `news_item_published_idx`, `news_entity_link_entity_idx`, `news_item_tsv_idx` |
| ECO | `econ_release_event_time_idx` |
| OMON / OVML | `option_terms_underlying_idx`, `option_chain_snapshot_latest_idx` |
| MEMB | `index_membership_idx` |
| Entitlement declarations | `access_log_licence_ts_idx` |

## 11. Seed strategy and volumes

`npm run db:seed` (`packages/server/src/seed/index.ts`) runs offline from `fixtures/` and is idempotent.

| Step | Source | Rows (dev) |
| --- | --- | --- |
| Licence registry, dq checks, ingest jobs, fa_line_map, calendars, exchanges, classification schemes (GICS from Wikipedia sectors) | `providers/licences.ts`, `seed/static/*.json`, core calendars | ~1,200 |
| Universe: S&P 500 constituents (SEC N-PORT SPY `sec-nport-SPY-primary_doc.xml` → ISIN/CUSIP/LEI/shares; SSGA holdings xlsx → weights/SEDOL; Wikipedia → GICS, CIK) + 50 ETFs + 30 indices (SPX, VIX, NDX, RTY, INDU, UKX, DAX, CAC, SX5E, NKY, HSI, AS51, …) + 9 G10 pairs + 2 crypto | fixtures | issuers ≈ 510, issues ≈ 570, instruments ≈ 600, listings ≈ 1,200 (OpenFIGI mapping fixture for AAPL; others minted from the composite until reconcile job runs), md_lines ≈ 1,500, xref ≈ 4,000 |
| Treasuries: bills 4/6/8/13/17/26/52W and notes/bonds 2/3/5/7/10/20/30Y as on-the-run instruments from the Treasury par + bill fixtures (CUSIPs backfilled by the `treasury.auctions` job when live), plus CMT synthetic instruments | `treasury-xml2`, `treasury-bills.xml`, `fed-h15.csv` | 40 instruments, `debt_terms` 40, `curve_point` ≈ 20 days × 25 |
| Rates: SOFR/EFFR/OBFR/TGCR/BGCR/SOFRAI | `nyfed-*` | ≈ 30 fixings |
| Econ: DGS1M…DGS30, CPIAUCSL, UNRATE, PAYEMS, GDP, FEDFUNDS, T10Y2Y, BLS CUUR0000SA0, WB/IMF GDP | `fred-DGS10.csv` (16,879 obs), `bls-cpi.json`, `worldbank`, `imf-weo.json` | series ≈ 60, observations ≈ 25k |
| Bars: AAPL max (169 quarterly rows) + 5y daily (1,255) + 1-minute (317); SPX 5d/5m; FTSE 1d; EURUSD 1d; ^TNX | `yahoo-chart-*` | ≈ 3,000 in dev; live: 600 × 1,260 ≈ 756k daily, intraday hot set ≈ 2.3M / 60 days |
| Corporate actions: AAPL dividends (20 × 5y + 84 max) and 5 splits | `yahoo-chart-AAPL-max-1d.json`, `yahoo-chart-events` | ≈ 110 |
| Options: AAPL chain 3,510 contracts (25 expiries) as `option_terms` + one `option_chain_snapshot` | `cboe-options` | 3,510 + 3,510 |
| Quotes/ticks: AAPL, SPX, VIX, BUK100P snapshots → `eod_snapshot` + tick rows | `cboe-*` | ≈ 10 |
| Fundamentals: AAPL companyfacts (≈ 50k facts across 505 concepts), submissions (1,000 filings), SPY submissions | `sec-companyfacts-AAPL.json`, `sec-submissions-*.json` | facts ≈ 50k, filings ≈ 1,050 |
| News: 5 Bloomberg feeds × 20 items, 8-K atom (40), Fed press (≈ 30) with entity links | `bbg-rss-*`, `sec-8k-atom.xml`, `fed-press-rss.xml` | ≈ 170 |
| Users: firm "Demo Desk" (5 seats), users `pm@demo`, `analyst@demo`, `rates@demo`, `compliance@demo`, `admin@demo`, password + optional WebAuthn; entitlements: firm `delayed` all classes; `rates@demo` extra `govt: delayed`; default workspaces, one watchlist ("US Megacap"), one portfolio ("Demo Long") with 12 lots, one room | `seed/users.ts` | tiny |

Production-like volumes (for capacity planning only): `access_log` ≈ 10 rows per screen view ⇒ 100 users ×
300 views/day ⇒ 300k rows/day (monthly partitions ≈ 6–9M rows, ~1 GB/month); `tick` ≈ 156k rows/day for a
100-name hot set; `fundamental_fact` ≈ 50k per issuer ⇒ 25M for the S&P 500 (fetched lazily on first
FA/EE per issuer, then refreshed weekly).
