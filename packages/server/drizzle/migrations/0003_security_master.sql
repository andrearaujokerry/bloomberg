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
