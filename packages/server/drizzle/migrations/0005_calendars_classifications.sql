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
