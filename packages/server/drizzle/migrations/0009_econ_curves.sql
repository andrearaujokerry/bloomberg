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
