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
