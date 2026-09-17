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
