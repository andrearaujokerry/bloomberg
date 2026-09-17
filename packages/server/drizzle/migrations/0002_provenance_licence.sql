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
