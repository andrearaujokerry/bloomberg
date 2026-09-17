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
