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
