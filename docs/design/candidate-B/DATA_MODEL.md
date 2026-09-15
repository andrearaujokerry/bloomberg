# DATA_MODEL — candidate B

Postgres 14, extensions `pg_trgm`, `btree_gist`, `pgcrypto`, `uuid-ossp`. No TimescaleDB, no
pgvector. All DDL below is committed as SQL migrations under
`packages/server/drizzle/migrations/` and mirrored 1:1 by Drizzle table definitions in
`packages/server/src/db/schema/*.ts` (Drizzle is used for typed queries; DDL authority is the SQL).

Migration files: `0001_ext_helpers.sql`, `0002_reference.sql`, `0003_timeseries.sql`,
`0004_fundamentals_econ.sql`, `0005_news.sql`, `0006_users_entitlements.sql`,
`0007_workspace_portfolio.sql`, `0008_messaging.sql`, `0009_ops.sql`, `0010_rls.sql`.

---

## 1. Conventions

| Convention | Rule |
| --- | --- |
| Ids | `bigint GENERATED ALWAYS AS IDENTITY` for internal ids; exposed on the wire as strings. Internal `instrument_id` is immutable and never reused (REF-01). Codes (`source_id`, `field_id`, `rate_code`) are `text`. |
| Time | `timestamptz` everywhere; dates that are calendar dates (bar date, ex-date) are `date`. |
| Numbers | `double precision` for high-volume series (bars, ticks); `numeric` for terms & conditions, corporate-action ratios, fundamentals and anything money-exact. |
| Bitemporal | Reference and fundamentals tables carry `valid tstzrange` (valid time) and `tx tstzrange` (transaction time). Rows are never updated in place: a change closes `tx` on the old row and inserts a new row. Exclusion constraints guarantee no overlapping versions per key. |
| Provenance | Every stored value row has `prov_id bigint REFERENCES provenance`. Derived rows (e.g. `fundamentals_std`) carry `prov_ids bigint[]`. |
| Naming | snake_case tables/columns; `_at` for timestamps; `_date` for dates; partitioned tables named `<table>_pYYYYMM` / `_pYYYYMMDD`. |
| Deletes | Only ops/retention jobs delete; app role has no `DELETE` on `messages`, `access_log`, `provenance`. |
| Tenant | Client-supplied data (`portfolios`, `positions`, `lots`, `watchlists`, `workspaces`, `messages`) carry `firm_id` and are covered by row-level security (§12). |

---

## 2. Extensions and bitemporal helpers (`0001_ext_helpers.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Bitemporal predicate; simple SQL function so the planner inlines it and range GiST indexes apply.
CREATE OR REPLACE FUNCTION bt_as_of(valid tstzrange, tx tstzrange, valid_at timestamptz, known_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT valid @> valid_at AND tx @> known_at
$$;

-- Default ranges: valid forever, known from now on.
CREATE OR REPLACE FUNCTION bt_valid_default() RETURNS tstzrange LANGUAGE sql IMMUTABLE AS $$
  SELECT tstzrange('-infinity'::timestamptz, 'infinity'::timestamptz, '[)')
$$;
CREATE OR REPLACE FUNCTION bt_tx_default() RETURNS tstzrange LANGUAGE sql STABLE AS $$
  SELECT tstzrange(now(), 'infinity'::timestamptz, '[)')
$$;

-- Close the transaction-time of a row (used by bitemporal writers; never UPDATE data columns).
-- Usage: UPDATE instruments SET tx = bt_close(tx) WHERE instrument_id = $1 AND upper_inf(tx);
CREATE OR REPLACE FUNCTION bt_close(tx tstzrange) RETURNS tstzrange LANGUAGE sql STABLE AS $$
  SELECT tstzrange(lower(tx), now(), '[)')
$$;

-- Trigger guard: bitemporal tables reject UPDATEs that touch anything other than tx.
CREATE OR REPLACE FUNCTION bt_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'tx' <> to_jsonb(OLD) - 'tx' THEN
    RAISE EXCEPTION 'bitemporal table %: only tx may be updated (close the row and insert a new version)', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
```

Drizzle helper (`packages/server/src/db/bitemporal.ts`):

```ts
import { customType, sql, SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

export type Range = { lo: Date | null; hi: Date | null };     // null = ±infinity, always '[)'

export const tstzrange = customType<{ data: Range; driverData: string }>({
  dataType: () => 'tstzrange',
  toDriver: (r) => `[${r.lo?.toISOString() ?? '-infinity'},${r.hi?.toISOString() ?? 'infinity'})`,
  fromDriver: (s) => {                                        // '["2026-09-15 14:00:00+00",infinity)'
    const m = /^[\[(]("?)([^,"]*)\1,("?)([^)\]"]*)\3[\])]$/.exec(s)!;
    const p = (v: string) => (v === '' || v === 'infinity' || v === '-infinity' ? null : new Date(v));
    return { lo: p(m[2]), hi: p(m[4]) };
  },
});

export const bitemporalColumns = {
  valid: tstzrange('valid').notNull().default(sql`bt_valid_default()`),
  tx:    tstzrange('tx').notNull().default(sql`bt_tx_default()`),
};

export interface AsOf { validAt?: Date; knownAt?: Date }        // defaults: now / now

/** WHERE fragment selecting the version of each row valid at `validAt` as known at `knownAt`. */
export function asOf(t: { valid: PgColumn; tx: PgColumn }, o: AsOf = {}): SQL {
  const v = o.validAt ?? new Date(), k = o.knownAt ?? new Date();
  return sql`bt_as_of(${t.valid}, ${t.tx}, ${v}::timestamptz, ${k}::timestamptz)`;
}

/** Current (latest known, valid now) rows. Same as asOf() with defaults but uses upper_inf for index hits. */
export const current = (t: { valid: PgColumn; tx: PgColumn }) =>
  sql`upper_inf(${t.tx}) AND ${t.valid} @> now()`;

/**
 * Bitemporal write: close the open tx of the row(s) matching `key` and insert `next`.
 * `validFrom` splits valid time; if omitted the new version supersedes the old for its whole valid range.
 */
export async function bitemporalUpsert<T extends PgTable>(db: Db, t: T, key: SQL, next: Insert<T>, validFrom?: Date): Promise<void>
```

Every bitemporal table gets:
```sql
ALTER TABLE <t> ADD CONSTRAINT <t>_bt_excl EXCLUDE USING gist (<key> WITH =, valid WITH &&, tx WITH &&);
CREATE TRIGGER <t>_bt_guard BEFORE UPDATE ON <t> FOR EACH ROW EXECUTE FUNCTION bt_guard_update();
CREATE INDEX <t>_current_idx ON <t> (<key>) WHERE upper_inf(tx);
```

Worked query (REF-03 example): "what did we believe the 10Y coupon was on 14 March, as of what we knew then":

```sql
SELECT coupon FROM govt_terms
WHERE instrument_id = $1
  AND bt_as_of(valid, tx, '2026-03-14T20:00:00Z', '2026-03-14T20:00:00Z');
```

---

## 3. Reference domain (`0002_reference.sql`)

```sql
CREATE TABLE sources (
  source_id    text PRIMARY KEY,                 -- 'openfigi','sec','cboe','yahoo','fred','nyfed','fedh15','treasury','frankfurter','bls','worldbank','imf','finra','fedrss','coingecko','ssga','wiki','synthetic','user'
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('symbology','exchange','aggregator','regulator','central_bank','statistics','fund_sponsor','reference','internal')),
  base_url     text,
  licence_id   text NOT NULL,                    -- FK added after licence_registry
  default_tier text NOT NULL CHECK (default_tier IN ('realtime','delayed','eod')),
  delay_minutes int NOT NULL DEFAULT 0
);

CREATE TABLE licence_registry (                  -- DATA-09; bitemporal (terms change)
  licence_id           text NOT NULL,
  source_id            text NOT NULL,
  terms_url            text,
  contract_ref         text,                     -- 'public-terms-2026-09' / signed contract id
  display_allowed      boolean NOT NULL,
  non_display_allowed  boolean NOT NULL,
  derived_allowed      boolean NOT NULL,
  redistribution_allowed boolean NOT NULL,
  export_allowed       boolean NOT NULL,
  api_allowed          boolean NOT NULL,
  retention_days       int,                      -- NULL = unlimited
  max_tier             text NOT NULL CHECK (max_tier IN ('realtime','delayed','eod')),
  attribution_text     text NOT NULL,
  rate_limit_note      text,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (licence_id, valid, tx),
  EXCLUDE USING gist (licence_id WITH =, valid WITH &&, tx WITH &&)
);
ALTER TABLE sources ADD FOREIGN KEY (licence_id) REFERENCES licence_registry (licence_id) NOT VALID; -- composite PK: enforce in app; NOT VALID keeps migration simple
-- (app-level FK; the registry PK is versioned)

CREATE TABLE field_licence (                     -- every field → source → permissions
  field_id     text NOT NULL,                    -- 'PX_LAST'
  source_id    text NOT NULL REFERENCES sources,
  licence_id   text NOT NULL,
  field_class  text NOT NULL CHECK (field_class IN ('quote','trade','ohlc','reference','fundamental','econ','rates','curve','derived','news','holdings','options','fx','crypto')),
  PRIMARY KEY (field_id, source_id)
);

CREATE TABLE provenance (                        -- DATA-10
  prov_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id      text NOT NULL REFERENCES sources,
  licence_id     text NOT NULL,
  replay_key     text NOT NULL,                  -- deterministic key into the replay store
  request_url    text NOT NULL,
  request_hash   text NOT NULL,                  -- sha256(method+url+body)
  response_hash  text NOT NULL,                  -- sha256(body)
  http_status    int  NOT NULL,
  fetched_at     timestamptz NOT NULL,           -- capture timestamp
  source_ts      timestamptz,                    -- provider's own timestamp if any
  adapter_version text NOT NULL,                 -- 'cboe/1.2.0'
  trace_id       text
);
CREATE INDEX provenance_source_fetched_idx ON provenance (source_id, fetched_at DESC);
CREATE INDEX provenance_replay_key_idx ON provenance (replay_key);

CREATE TABLE calendars (
  calendar_id text PRIMARY KEY,                  -- 'NYSE','SIFMA','TARGET2','FX','WEEKEND'
  name        text NOT NULL,
  tz          text NOT NULL                      -- 'America/New_York'
);
CREATE TABLE calendar_holidays (
  calendar_id text NOT NULL REFERENCES calendars,
  hol_date    date NOT NULL,
  name        text NOT NULL,
  early_close time,                              -- SIFMA/NYSE half days
  PRIMARY KEY (calendar_id, hol_date)
);

CREATE TABLE exchanges (
  mic          text PRIMARY KEY,                 -- 'XNAS','XNYS','ARCX','BATS','XCBO','XLON'
  name         text NOT NULL,
  country      text NOT NULL,
  calendar_id  text NOT NULL REFERENCES calendars,
  tz           text NOT NULL,
  open_time    time NOT NULL, close_time time NOT NULL,
  bbg_exch_code text,                            -- OpenFIGI exchCode: 'UW','UN','UA','UP','UQ','UR','UT','UV','US'(composite)
  cboe_exchange_id int                           -- Cboe 'exchange_id' (2 = Nasdaq listed stock, 5 = Cboe index, 115 = Cboe Europe)
);

CREATE TABLE issuers (                            -- REF-02 level 1; bitemporal
  issuer_id    bigint GENERATED ALWAYS AS IDENTITY,
  name         text NOT NULL,
  lei          text,
  cik          int,                              -- SEC CIK (submissions.cik)
  country      text,                             -- ISO-2
  state_of_inc text,
  sic          text,                             -- submissions.sic '3571'
  sic_desc     text,
  fiscal_year_end text,                          -- '0926'
  category     text,                             -- 'Large accelerated filer'
  website      text,
  entity_type  text,                             -- 'operating','other'
  prov_id      bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (issuer_id, valid, tx),
  EXCLUDE USING gist (issuer_id WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX issuers_cik_idx ON issuers (cik) WHERE upper_inf(tx);
CREATE INDEX issuers_name_trgm ON issuers USING gin (name gin_trgm_ops);

CREATE TABLE issues (                             -- REF-02 level 2 (share class / bond issue / fund); bitemporal
  issue_id        bigint GENERATED ALWAYS AS IDENTITY,
  issuer_id       bigint NOT NULL,
  asset_class     text NOT NULL CHECK (asset_class IN ('equity','etf','index','fx','govt','option','future','crypto','rate','econ')),
  name            text NOT NULL,
  share_class_figi text,                         -- OpenFIGI shareClassFIGI
  isin            text, cusip text, sedol text,
  currency        text NOT NULL,
  security_type   text,                          -- OpenFIGI securityType: 'Common Stock','REIT','ETP','Equity Option'
  security_type2  text,                          -- 'Common Stock','Mutual Fund','Option'
  prov_id         bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (issue_id, valid, tx),
  EXCLUDE USING gist (issue_id WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX issues_issuer_idx ON issues (issuer_id) WHERE upper_inf(tx);
CREATE INDEX issues_isin_idx ON issues (isin) WHERE upper_inf(tx);

CREATE TABLE instruments (                        -- REF-02 level 3: the thing a user loads; bitemporal
  instrument_id   bigint GENERATED ALWAYS AS IDENTITY,
  issue_id        bigint NOT NULL,
  asset_class     text NOT NULL,
  ticker          text NOT NULL,                 -- 'AAPL','SPX','EURUSD','T 4.25 08/15/35','SOFRRATE','CPIAUCSL'
  market_sector   text NOT NULL CHECK (market_sector IN ('Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto')),
  composite_figi  text,                          -- OpenFIGI compositeFIGI (BBG000B9XRY4)
  exch_code       text,                          -- composite code shown in the key: 'US'
  name            text NOT NULL,
  short_name      text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','delisted','expired')),
  primary_listing_id bigint,                     -- set after listings insert
  quote_currency  text NOT NULL,
  price_scale     int NOT NULL DEFAULT 2,        -- display decimals (Yahoo priceHint)
  lot_size        int,
  prov_id         bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (instrument_id, valid, tx),
  EXCLUDE USING gist (instrument_id WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX instruments_key_idx ON instruments (ticker, market_sector, exch_code) WHERE upper_inf(tx);
CREATE INDEX instruments_figi_idx ON instruments (composite_figi) WHERE upper_inf(tx);
CREATE INDEX instruments_name_trgm ON instruments USING gin (name gin_trgm_ops);
CREATE INDEX instruments_ticker_trgm ON instruments USING gin (ticker gin_trgm_ops);

CREATE TABLE listings (                           -- REF-02 level 4; bitemporal
  listing_id    bigint GENERATED ALWAYS AS IDENTITY,
  instrument_id bigint NOT NULL,
  figi          text,                            -- exchange-level FIGI (BBG000B9XVV8 = AAPL UN)
  mic           text REFERENCES exchanges,
  bbg_exch_code text,                            -- 'UW','UN',...,'US'
  ticker        text NOT NULL,
  currency      text NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  is_composite  boolean NOT NULL DEFAULT false,  -- the 'US' composite listing
  prov_id       bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (listing_id, valid, tx),
  EXCLUDE USING gist (listing_id WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX listings_instrument_idx ON listings (instrument_id) WHERE upper_inf(tx);
CREATE INDEX listings_figi_idx ON listings (figi) WHERE upper_inf(tx);

CREATE TABLE md_lines (                           -- REF-02 level 5: one listing, many market-data lines
  line_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id    bigint NOT NULL,
  source_id     text NOT NULL REFERENCES sources,
  source_symbol text NOT NULL,                   -- Cboe 'AAPL' / '_SPX'; Yahoo 'AAPL' / '^GSPC' / 'EURUSD=X' / '^TNX'
  tier          text NOT NULL CHECK (tier IN ('realtime','delayed','eod')),
  priority      int  NOT NULL DEFAULT 100,       -- lower wins in composite (Cboe 10, Yahoo 20, Stooq 30)
  field_classes text[] NOT NULL,                 -- which classes this line contributes
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (listing_id, source_id, source_symbol)
);
CREATE INDEX md_lines_source_symbol_idx ON md_lines (source_id, source_symbol);

CREATE TABLE identifiers (                        -- REF-01 cross-reference; bitemporal (tickers are reused)
  ident_id     bigint GENERATED ALWAYS AS IDENTITY,
  scheme       text NOT NULL CHECK (scheme IN ('FIGI','COMPOSITE_FIGI','SHARE_CLASS_FIGI','ISIN','CUSIP','SEDOL','RIC','TICKER_EXCH','LEI','MIC','CIK','OCC','YAHOO','CBOE','FRED','BLS','NYFED','H15','TREASURY','WB','IMF')),
  value        text NOT NULL,
  level        text NOT NULL CHECK (level IN ('issuer','issue','instrument','listing')),
  target_id    bigint NOT NULL,                  -- id at that level
  prov_id      bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (ident_id, valid, tx),
  -- an identifier value maps to at most one target at any valid/known time
  EXCLUDE USING gist (scheme WITH =, value WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX identifiers_lookup_idx ON identifiers (scheme, value) WHERE upper_inf(tx);
CREATE INDEX identifiers_target_idx ON identifiers (level, target_id) WHERE upper_inf(tx);

CREATE TABLE classifications (                   -- REF-07 schemes
  scheme text NOT NULL CHECK (scheme IN ('GICS','SIC','NAICS','ICB','INTERNAL','SSGA_SECTOR','NPORT_ASSETCAT')),
  code   text NOT NULL,
  name   text NOT NULL,
  parent_code text,
  PRIMARY KEY (scheme, code)
);
CREATE TABLE instrument_classifications (        -- bitemporal
  instrument_id bigint NOT NULL,
  scheme text NOT NULL, code text NOT NULL,
  prov_id bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (instrument_id, scheme, valid, tx),
  FOREIGN KEY (scheme, code) REFERENCES classifications,
  EXCLUDE USING gist (instrument_id WITH =, scheme WITH =, valid WITH &&, tx WITH &&)
);

CREATE TABLE indices (
  index_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id bigint NOT NULL,                 -- the index instrument (SPX Index)
  code          text NOT NULL UNIQUE,            -- 'SPX','NDX','RTY','INDU','UKX','DAX','NKY','SX5E','VIX'
  name          text NOT NULL,
  provider      text NOT NULL,
  membership_source text                         -- 'sec_nport:SPY','ssga:SPY','wiki'
);
CREATE TABLE index_memberships (                 -- REF-07 with history; bitemporal on valid (membership dates) and tx
  index_id      bigint NOT NULL REFERENCES indices,
  instrument_id bigint NOT NULL,
  weight        numeric(12,9),                   -- fraction (N-PORT pctVal/100, SSGA Weight/100)
  shares        numeric(20,4),
  market_value  numeric(22,2),
  as_of         date NOT NULL,                   -- holdings date the weight refers to
  prov_id       bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (index_id, instrument_id, as_of, valid, tx),
  EXCLUDE USING gist (index_id WITH =, instrument_id WITH =, as_of WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX index_memberships_idx ON index_memberships (index_id, as_of DESC) WHERE upper_inf(tx);
CREATE INDEX index_memberships_member_idx ON index_memberships (instrument_id) WHERE upper_inf(tx);

CREATE TABLE govt_terms (                         -- REF-04 (Treasuries only); bitemporal
  instrument_id  bigint NOT NULL,
  cusip          text NOT NULL,
  sec_type       text NOT NULL CHECK (sec_type IN ('bill','note','bond','tips','frn')),
  issue_date     date NOT NULL,
  maturity_date  date NOT NULL,
  coupon         numeric(9,6),                   -- percent, NULL for bills
  coupon_freq    int NOT NULL DEFAULT 2,
  day_count      text NOT NULL DEFAULT 'ACT/ACT' CHECK (day_count IN ('ACT/ACT','ACT/360','ACT/365F','30/360','30E/360')),
  bdc            text NOT NULL DEFAULT 'FOLLOWING',
  first_coupon   date, last_regular_coupon date,
  dated_date     date,
  settlement_days int NOT NULL DEFAULT 1,
  calendar_id    text NOT NULL DEFAULT 'SIFMA',
  callable       boolean NOT NULL DEFAULT false,
  call_schedule  jsonb,                          -- [{date, price}] – unused for current Treasuries but modelled
  benchmark_tenor text,                          -- '2Y','5Y','10Y','30Y' when on-the-run
  prov_id        bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (instrument_id, valid, tx),
  EXCLUDE USING gist (instrument_id WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX govt_terms_maturity_idx ON govt_terms (maturity_date) WHERE upper_inf(tx);

CREATE TABLE option_terms (                       -- REF-05
  instrument_id  bigint PRIMARY KEY,
  underlying_id  bigint NOT NULL,
  occ_symbol     text NOT NULL UNIQUE,           -- 'AAPL260916C00245000'
  expiry         date NOT NULL,
  strike         numeric(14,4) NOT NULL,
  put_call       char(1) NOT NULL CHECK (put_call IN ('C','P')),
  multiplier     int NOT NULL DEFAULT 100,
  exercise_style text NOT NULL DEFAULT 'american' CHECK (exercise_style IN ('american','european')),
  settlement     text NOT NULL DEFAULT 'physical' CHECK (settlement IN ('physical','cash')),
  am_pm          text NOT NULL DEFAULT 'pm',
  tick_size      numeric(8,4),
  prov_id        bigint REFERENCES provenance
);
CREATE INDEX option_terms_chain_idx ON option_terms (underlying_id, expiry, strike);

CREATE TABLE corporate_actions (                  -- DATA-08 / REF-09; bitemporal
  ca_id          bigint GENERATED ALWAYS AS IDENTITY,
  instrument_id  bigint NOT NULL,
  ca_type        text NOT NULL CHECK (ca_type IN ('cash_dividend','special_dividend','stock_dividend','split','reverse_split','spinoff','merger','tender','rights','name_change','ticker_change','delisting','call','conversion')),
  status         text NOT NULL CHECK (status IN ('estimated','announced','confirmed','applied','cancelled')),
  declared_date  date, ex_date date NOT NULL, record_date date, pay_date date, effective_date date,
  amount         numeric(18,8),                  -- per share cash
  currency       text,
  ratio_num      numeric(18,8),                  -- split: new/old e.g. 4/1 → 4, 1
  ratio_den      numeric(18,8),
  price_adj_factor numeric(18,12),               -- computed at write for convenience; adjustment itself is applied on read
  volume_adj_factor numeric(18,12),
  related_instrument_id bigint,                  -- spinoff/merger counterparty
  notes          text,
  prov_id        bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (ca_id, valid, tx),
  EXCLUDE USING gist (ca_id WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX corporate_actions_inst_ex_idx ON corporate_actions (instrument_id, ex_date) WHERE upper_inf(tx);

CREATE TABLE entities (                           -- REF-08 (people & organisations; minimal)
  entity_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('person','organisation','government_body')),
  name        text NOT NULL,
  role        text,                              -- 'Fed Chair','CEO'
  org_issuer_id bigint,
  external_ref text,                             -- e.g. SEC reporter CIK from Form 4
  prov_id     bigint REFERENCES provenance,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  EXCLUDE USING gist (entity_id WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX entities_name_trgm ON entities USING gin (name gin_trgm_ops);
CREATE TABLE entity_relations (
  from_entity bigint NOT NULL, to_entity bigint NOT NULL,
  relation text NOT NULL CHECK (relation IN ('officer_of','director_of','subsidiary_of','parent_of','supplier_of','customer_of','holder_of')),
  since date, until date,
  prov_id bigint REFERENCES provenance,
  PRIMARY KEY (from_entity, to_entity, relation)
);
```

### 3.1 Adjustment-on-read (REF-09)

Adjustment is never baked into `bars_*`. Reads call `adjustment_factors(instrument_id, policy)`:

```sql
-- Returns per ex_date cumulative factors to apply to prices strictly before ex_date.
-- policy: 'unadjusted' | 'price' (splits + stock dividends) | 'total_return' (also cash dividends, Yahoo-style: 1 - div/close_prev)
CREATE OR REPLACE FUNCTION adjustment_factors(p_instrument_id bigint, p_policy text, p_known_at timestamptz DEFAULT now())
RETURNS TABLE (ex_date date, price_factor numeric, volume_factor numeric)
LANGUAGE sql STABLE AS $$
  WITH ca AS (
    SELECT c.ex_date,
           CASE
             WHEN c.ca_type IN ('split','reverse_split','stock_dividend') THEN c.ratio_den / c.ratio_num
             WHEN p_policy = 'total_return' AND c.ca_type IN ('cash_dividend','special_dividend')
               THEN 1 - c.amount / NULLIF((SELECT b.close FROM bars_1d b WHERE b.instrument_id = c.instrument_id AND b.bar_date < c.ex_date ORDER BY b.bar_date DESC LIMIT 1), 0)
             ELSE 1
           END AS pf,
           CASE WHEN c.ca_type IN ('split','reverse_split','stock_dividend') THEN c.ratio_num / c.ratio_den ELSE 1 END AS vf
    FROM corporate_actions c
    WHERE c.instrument_id = p_instrument_id
      AND c.status IN ('confirmed','applied')
      AND bt_as_of(c.valid, c.tx, c.ex_date::timestamptz, p_known_at)
      AND p_policy <> 'unadjusted'
  )
  SELECT ex_date,
         exp(sum(ln(pf)) OVER (ORDER BY ex_date DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::numeric,
         exp(sum(ln(vf)) OVER (ORDER BY ex_date DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::numeric
  FROM ca ORDER BY ex_date
$$;
```

The TypeScript twin `core/adjust/corporateActions.ts` implements the same maths for the client
(charts re-adjust locally when the user toggles policy) and is golden-tested against the SQL.

---

## 4. Time series (`0003_timeseries.sql`)

```sql
CREATE TABLE bars_1d (                            -- unadjusted daily bars
  instrument_id bigint NOT NULL,
  bar_date      date   NOT NULL,
  open double precision, high double precision, low double precision, close double precision NOT NULL,
  volume        bigint,
  vwap          double precision,
  source_id     text NOT NULL REFERENCES sources,
  prov_id       bigint NOT NULL REFERENCES provenance,
  PRIMARY KEY (instrument_id, bar_date)
);
CREATE INDEX bars_1d_date_idx ON bars_1d (bar_date);

CREATE TABLE bars_1m (                            -- intraday 1-minute (Yahoo); range-partitioned monthly
  instrument_id bigint NOT NULL,
  ts            timestamptz NOT NULL,             -- bar start (exchange tz converted to UTC)
  open double precision, high double precision, low double precision, close double precision NOT NULL,
  volume        bigint,
  session       text NOT NULL DEFAULT 'regular' CHECK (session IN ('pre','regular','post')),
  prov_id       bigint NOT NULL,
  PRIMARY KEY (instrument_id, ts)
) PARTITION BY RANGE (ts);
CREATE TABLE bars_1m_default PARTITION OF bars_1m DEFAULT;
-- partitions: bars_1m_p202609 FOR VALUES FROM ('2026-09-01') TO ('2026-10-01'), created by db/partitions.ts (horizon = 3 months)

CREATE TABLE quote_ticks (                        -- STOR-01 stand-in: every distinct Cboe/Yahoo quote snapshot; partitioned daily
  instrument_id bigint NOT NULL,
  ts            timestamptz NOT NULL,             -- capture ts
  src_ts        timestamptz,                      -- last_trade_time
  src_seq       bigint,                           -- Cboe seqno
  source_id     text NOT NULL,
  last double precision, bid double precision, ask double precision,
  bid_size int, ask_size int,
  open double precision, high double precision, low double precision, prev_close double precision,
  volume bigint, iv30 double precision,
  tick          char(1),                          -- 'u','d','n'
  prov_id       bigint NOT NULL,
  PRIMARY KEY (instrument_id, ts)
) PARTITION BY RANGE (ts);
CREATE TABLE quote_ticks_default PARTITION OF quote_ticks DEFAULT;
-- partitions quote_ticks_p20260915 … daily, horizon 7 days; retention 30 days (job retention.purge)

CREATE TABLE option_chain_snapshots (             -- Cboe options chain; partitioned daily
  instrument_id bigint NOT NULL,                  -- option instrument
  ts            timestamptz NOT NULL,
  bid double precision, ask double precision, bid_size int, ask_size int,
  last double precision, last_ts timestamptz, volume int, open_interest int,
  iv double precision, delta double precision, gamma double precision, vega double precision, theta double precision, rho double precision, theo double precision,
  prov_id bigint NOT NULL,
  PRIMARY KEY (instrument_id, ts)
) PARTITION BY RANGE (ts);
CREATE TABLE option_chain_snapshots_default PARTITION OF option_chain_snapshots DEFAULT;

CREATE TABLE fx_rates (                           -- frankfurter (ECB reference) + Yahoo intraday closes
  base   text NOT NULL, quote text NOT NULL,
  rate_date date NOT NULL,
  rate   numeric(18,8) NOT NULL,
  source_id text NOT NULL,
  prov_id bigint NOT NULL,
  PRIMARY KEY (base, quote, rate_date, source_id)
);

CREATE TABLE rates_observations (                 -- NY Fed reference rates, Fed H.15, FRED daily rates
  rate_code   text NOT NULL,                      -- 'SOFR','EFFR','OBFR','TGCR','BGCR','SOFRAI','H15_RIFLGFCY10_N.B','DGS10'
  obs_date    date NOT NULL,
  value       numeric(12,6),                      -- NULL = 'ND'/'.' (not available)
  pct_1 numeric(12,6), pct_25 numeric(12,6), pct_75 numeric(12,6), pct_99 numeric(12,6),
  volume_bn   numeric(14,2),
  target_from numeric(8,4), target_to numeric(8,4),
  avg_30d numeric(12,8), avg_90d numeric(12,8), avg_180d numeric(12,8), index_value numeric(16,10),
  revision    text,                               -- NY Fed revisionIndicator
  vintage_date date NOT NULL DEFAULT current_date,-- when we captured it (revisions create new vintage rows)
  source_id   text NOT NULL,
  prov_id     bigint NOT NULL,
  PRIMARY KEY (rate_code, obs_date, vintage_date)
);

CREATE TABLE curves (
  curve_id   text PRIMARY KEY,                    -- 'UST_PAR','UST_BILL','UST_ZERO','SOFR_OIS','FED_H15_CMT'
  name       text NOT NULL,
  currency   text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('par','zero','discount','forward','ois','money_market')),
  day_count  text NOT NULL,
  compounding text NOT NULL,                      -- 'semiannual','annual','continuous','simple'
  source_id  text NOT NULL,
  build_method text                               -- 'published' | 'bootstrap:v1'
);
CREATE TABLE curve_points (
  curve_id   text NOT NULL REFERENCES curves,
  curve_date date NOT NULL,
  tenor      text NOT NULL,                       -- '1M','1.5M','2M','3M','4M','6M','1Y','2Y','3Y','5Y','7Y','10Y','20Y','30Y' / '4WK'...
  tenor_days int  NOT NULL,
  value      numeric(14,10) NOT NULL,             -- percent for par/zero, factor for discount
  vintage_date date NOT NULL DEFAULT current_date,
  prov_id    bigint NOT NULL,
  PRIMARY KEY (curve_id, curve_date, tenor, vintage_date)
);
CREATE INDEX curve_points_latest_idx ON curve_points (curve_id, curve_date DESC);

CREATE TABLE short_interest (                     -- FINRA consolidated
  instrument_id bigint NOT NULL,
  settlement_date date NOT NULL,
  current_qty bigint, previous_qty bigint, avg_daily_volume bigint, days_to_cover numeric(10,2),
  change_pct numeric(10,4), revision boolean,
  prov_id bigint NOT NULL,
  PRIMARY KEY (instrument_id, settlement_date)
);

CREATE TABLE etf_holdings (                       -- N-PORT / SSGA holdings; used for HDS fallback and MEMB
  etf_instrument_id bigint NOT NULL,
  as_of         date NOT NULL,
  holding_instrument_id bigint,                   -- resolved via CUSIP/ISIN; NULL when unresolved
  name          text NOT NULL,
  cusip text, isin text, lei text, sedol text, ticker text,
  shares        numeric(20,4), market_value numeric(22,2), weight numeric(12,9),
  asset_cat     text,                             -- N-PORT assetCat 'EC','DBT','STIV'
  issuer_cat    text,
  country       text,
  source_id     text NOT NULL,
  prov_id       bigint NOT NULL,
  PRIMARY KEY (etf_instrument_id, as_of, name, source_id)
);
CREATE INDEX etf_holdings_holding_idx ON etf_holdings (holding_instrument_id, as_of DESC);
```

Partition maintenance (`db/partitions.ts`): `ensurePartitions('bars_1m','month',3)`,
`ensurePartitions('quote_ticks','day',7)`, `ensurePartitions('option_chain_snapshots','day',7)`,
`ensurePartitions('access_log','month',3)`, `ensurePartitions('usage_events','month',3)`; runs at
startup and daily 00:05. Retention: `quote_ticks` 30 d, `option_chain_snapshots` 14 d, `bars_1m`
120 d, others unlimited unless `licence_registry.retention_days` says otherwise (STOR-07).

---

## 5. Fundamentals and economics (`0004_fundamentals_econ.sql`)

```sql
CREATE TABLE filings (                            -- SEC submissions.recent (and older files)
  accn           text PRIMARY KEY,                -- '0000320193-26-000020'
  cik            int  NOT NULL,
  form           text NOT NULL,                   -- '10-K','10-Q','8-K','4','DEF 14A','SC 13G',...
  filed_at       date NOT NULL,                   -- filingDate
  report_date    date,                            -- reportDate
  acceptance_ts  timestamptz,                     -- acceptanceDateTime
  items          text,                            -- 8-K items '5.02,9.01'
  primary_doc    text,                            -- 'aapl-20260627.htm'
  primary_doc_desc text,
  is_xbrl        boolean NOT NULL DEFAULT false,
  is_inline_xbrl boolean NOT NULL DEFAULT false,
  size_bytes     int,
  url            text GENERATED ALWAYS AS ('https://www.sec.gov/Archives/edgar/data/' || cik::text || '/' || replace(accn,'-','') || '/' || coalesce(primary_doc,'')) STORED,
  prov_id        bigint NOT NULL
);
CREATE INDEX filings_cik_filed_idx ON filings (cik, filed_at DESC);
CREATE INDEX filings_form_filed_idx ON filings (form, filed_at DESC);

CREATE TABLE xbrl_facts (                         -- SEC companyfacts, point-in-time keyed on filed_at (STOR-06)
  cik          int  NOT NULL,
  taxonomy     text NOT NULL,                     -- 'us-gaap','dei'
  concept      text NOT NULL,                     -- 'RevenueFromContractWithCustomerExcludingAssessedTax'
  unit         text NOT NULL,                     -- 'USD','shares','USD/shares'
  period_start date,                              -- NULL for instant facts
  period_end   date NOT NULL,
  value        numeric(28,6) NOT NULL,
  accn         text NOT NULL,
  fy           int, fp text,                      -- 2026, 'Q2'/'FY'
  form         text NOT NULL,
  filed_at     date NOT NULL,
  frame        text,                              -- 'CY2026Q1' when SEC deduplicated this fact into a frame
  prov_id      bigint NOT NULL,
  PRIMARY KEY (cik, taxonomy, concept, unit, period_end, period_start, accn)
);
CREATE INDEX xbrl_facts_pit_idx ON xbrl_facts (cik, concept, period_end, filed_at DESC);
CREATE INDEX xbrl_facts_frame_idx ON xbrl_facts (concept, frame) WHERE frame IS NOT NULL;

-- Point-in-time read: latest filing of each period known at :known_at.
-- SELECT DISTINCT ON (period_end, period_start) * FROM xbrl_facts
--  WHERE cik=$1 AND concept=$2 AND unit=$3 AND filed_at <= $4::date
--  ORDER BY period_end DESC, period_start DESC, filed_at DESC;

CREATE TABLE fundamentals_std (                   -- standardised line items (DATA-06 "standardisation is the product"); bitemporal by filed_at
  issuer_id    bigint NOT NULL,
  statement    text NOT NULL CHECK (statement IN ('IS','BS','CF','RATIO','PER_SHARE','SEGMENT')),
  line_item    text NOT NULL,                     -- 'REVENUE','GROSS_PROFIT','EBIT','NET_INCOME','EPS_DILUTED','TOTAL_ASSETS','FCF','ROE',...
  period_type  text NOT NULL CHECK (period_type IN ('Q','FY','TTM','LTM')),
  period_end   date NOT NULL,
  fiscal_year  int, fiscal_period text,
  value        numeric(28,6),
  currency     text NOT NULL DEFAULT 'USD',
  as_reported  boolean NOT NULL DEFAULT false,     -- FA toggle: standardised vs as-reported
  mapping_version text NOT NULL,                  -- 'std-map/2026.09' — which concept map produced this
  source_accns text[] NOT NULL,
  filed_at     date NOT NULL,                     -- valid-time anchor (STOR-06)
  prov_ids     bigint[] NOT NULL,
  valid tstzrange NOT NULL,                       -- [filed_at, next restatement)
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (issuer_id, statement, line_item, period_type, period_end, as_reported, valid, tx),
  EXCLUDE USING gist (issuer_id WITH =, statement WITH =, line_item WITH =, period_type WITH =, period_end WITH =, as_reported WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX fundamentals_std_lookup_idx ON fundamentals_std (issuer_id, line_item, period_end DESC) WHERE upper_inf(tx);

CREATE TABLE concept_map (                        -- us-gaap concept → standard line item, with precedence
  mapping_version text NOT NULL,
  line_item   text NOT NULL,
  taxonomy    text NOT NULL, concept text NOT NULL,
  precedence  int NOT NULL,                       -- 1 = preferred concept ('Revenues' vs 'RevenueFromContract...')
  sign        int NOT NULL DEFAULT 1,
  PRIMARY KEY (mapping_version, line_item, taxonomy, concept)
);

CREATE TABLE econ_series (
  series_id   text PRIMARY KEY,                   -- 'FRED:DGS10','FRED:CPIAUCSL','BLS:CUUR0000SA0','WB:US:NY.GDP.MKTP.CD','IMF:USA:NGDP_RPCH'
  source_id   text NOT NULL REFERENCES sources,
  external_id text NOT NULL,
  name        text NOT NULL,
  units       text, frequency text NOT NULL CHECK (frequency IN ('D','W','M','Q','A')),
  seasonal_adj text,
  country     text NOT NULL DEFAULT 'US',
  bbg_ticker  text,                               -- 'CPI YOY','USURTOT','NFP TCH' (Index sector)
  instrument_id bigint,                           -- econ instruments are loadable securities (asset_class 'econ')
  release_id  bigint,
  last_obs_date date, last_updated timestamptz
);
CREATE INDEX econ_series_name_trgm ON econ_series USING gin (name gin_trgm_ops);

CREATE TABLE econ_observations (                  -- with revisions: one row per vintage
  series_id    text NOT NULL REFERENCES econ_series,
  obs_date     date NOT NULL,
  value        numeric(20,6),                     -- NULL = missing ('.', '-', 'ND')
  vintage_date date NOT NULL,                     -- date this value became known to us (realtime_start)
  footnote     text,                              -- BLS footnote code/text
  prov_id      bigint NOT NULL,
  PRIMARY KEY (series_id, obs_date, vintage_date)
);
-- latest vintage as of :known: SELECT DISTINCT ON (obs_date) ... WHERE vintage_date <= :known ORDER BY obs_date, vintage_date DESC

CREATE TABLE econ_releases (
  release_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id   text NOT NULL,
  external_id text,                               -- FRED rid '10', BLS 'cpi'
  name        text NOT NULL,                      -- 'Consumer Price Index'
  country     text NOT NULL DEFAULT 'US',
  importance  int NOT NULL DEFAULT 2 CHECK (importance BETWEEN 1 AND 3),
  UNIQUE (source_id, external_id)
);
CREATE TABLE econ_release_events (                -- ECO calendar rows
  event_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id   bigint NOT NULL REFERENCES econ_releases,
  scheduled_at timestamptz NOT NULL,               -- BLS '08:30 AM' ET; FRED calendar date (time NULL → 08:30 default flag)
  time_known   boolean NOT NULL DEFAULT true,
  period_label text,                               -- 'August 2026'
  series_id    text REFERENCES econ_series,
  actual       numeric(20,6), prior numeric(20,6), revised_prior numeric(20,6),
  consensus    numeric(20,6),                      -- always NULL in v1 (no consensus source) → reason 'NO_CONSENSUS_SOURCE'
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','released','revised','cancelled')),
  prov_id      bigint NOT NULL,
  UNIQUE (release_id, scheduled_at, period_label)
);
CREATE INDEX econ_release_events_time_idx ON econ_release_events (scheduled_at);

CREATE TABLE fomc_meetings (
  meeting_date date PRIMARY KEY,                   -- decision day
  statement_at timestamptz,
  has_sep boolean NOT NULL DEFAULT false,
  prov_id bigint
);
```

---

## 6. News (`0005_news.sql`)

```sql
CREATE TABLE news_topics (
  topic_code text PRIMARY KEY,                     -- 'MARKETS','ECONOMICS','POLITICS','TECHNOLOGY','WEALTH','INDUSTRIES','FED','SEC8K','EARNINGS','RATES','FX'
  name text NOT NULL,
  parent_code text
);

CREATE TABLE news_items (
  news_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     text NOT NULL REFERENCES sources,  -- 'bbgrss','fedrss','sec'
  guid          text NOT NULL,                     -- RSS guid 'TLEUW0KGZAKZ00' / Atom id 'urn:tag:sec.gov,2008:accession-number=...' / Fed URL
  headline      text NOT NULL,
  summary       text,
  body          text,                              -- never populated for Bloomberg RSS (link-out only)
  url           text NOT NULL,
  author        text,                              -- dc:creator
  category      text,                              -- Fed <category>
  lang          text NOT NULL DEFAULT 'en',
  published_at  timestamptz NOT NULL,              -- pubDate / <updated>
  captured_at   timestamptz NOT NULL,              -- our receipt
  is_correction boolean NOT NULL DEFAULT false,    -- description starts with 'Correct:' / 'Fixes headline'
  machine_generated boolean NOT NULL DEFAULT false,-- NEWS-08 (always false in v1)
  form_type     text,                              -- '8-K' for SEC feed
  items_8k      text[],                            -- ['5.02','9.01']
  cik           int,
  fts           tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(headline,'')),'A') || setweight(to_tsvector('english', coalesce(summary,'')),'B')) STORED,
  prov_id       bigint NOT NULL,
  UNIQUE (source_id, guid)
);
CREATE INDEX news_items_published_idx ON news_items (published_at DESC);
CREATE INDEX news_items_fts_idx ON news_items USING gin (fts);
CREATE INDEX news_items_headline_trgm ON news_items USING gin (headline gin_trgm_ops);

CREATE TABLE news_entity_links (                   -- NEWS-02
  news_id     bigint NOT NULL REFERENCES news_items ON DELETE CASCADE,
  entity_kind text NOT NULL CHECK (entity_kind IN ('instrument','issuer','entity','topic','econ_series')),
  entity_id   text NOT NULL,                       -- instrument_id / issuer_id / entity_id / topic_code / series_id
  confidence  real NOT NULL,                       -- 1.0 = exact CIK/ticker match; 0.9 name match; <0.8 not linked
  method      text NOT NULL,                       -- 'cik','ticker_token','name_exact','alias','feed_category'
  PRIMARY KEY (news_id, entity_kind, entity_id)
);
CREATE INDEX news_entity_links_entity_idx ON news_entity_links (entity_kind, entity_id, news_id DESC);
```

---

## 7. Users, sessions, entitlements, access log (`0006_users_entitlements.sql`)

```sql
CREATE TABLE firms (
  firm_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  lei        text,
  status     text NOT NULL DEFAULT 'active',
  policy     jsonb NOT NULL DEFAULT '{}'::jsonb   -- MSG-03: {retentionDays, permittedCounterpartyFirms:[], disclaimer, ethicalWalls:[{deskA,deskB}]}
);

CREATE TABLE users (
  user_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id      bigint NOT NULL REFERENCES firms,
  email        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  desk         text,                               -- 'Equities PM','Rates'
  role         text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','compliance','support')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','deprovisioned')),
  password_hash text,                              -- crypt(); dev/fallback only
  mfa_required boolean NOT NULL DEFAULT false,
  verified_at  timestamptz,                        -- SEC-01 identity verification
  sanctions_screened_at timestamptz,               -- REG-06 (manual attestation field)
  created_at   timestamptz NOT NULL DEFAULT now(),
  scim_external_id text
);

CREATE TABLE webauthn_credentials (                -- SEC-02
  credential_id bytea PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users,
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0,
  transports    text[],
  aaguid        uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE TABLE sessions (                            -- ENTL-03 / SEC-03
  session_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       bigint NOT NULL REFERENCES users,
  token_hash    bytea NOT NULL UNIQUE,             -- sha256(token)
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip            inet, user_agent text,
  client_kind   text NOT NULL CHECK (client_kind IN ('web','sdk','api_key')),
  device_id     text,
  revoked_at    timestamptz, revoke_reason text,   -- 'SESSION_SUPERSEDED','LOGOUT','ADMIN','EXPIRED'
  superseded_count int NOT NULL DEFAULT 0
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE entitlements (                        -- ENTL-01/02; bitemporal
  entl_id      bigint GENERATED ALWAYS AS IDENTITY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('user','firm')),
  subject_id   bigint NOT NULL,
  source_id    text NOT NULL REFERENCES sources,
  field_class  text NOT NULL,                      -- '*' or a field_class
  tier         text NOT NULL CHECK (tier IN ('realtime','delayed','eod','none')),
  usage        text NOT NULL CHECK (usage IN ('display','export','api','non_display')),
  instrument_scope text NOT NULL DEFAULT '*',      -- '*' | 'index:SPX' | 'instrument:123'
  granted_by   bigint,
  valid tstzrange NOT NULL DEFAULT bt_valid_default(),
  tx    tstzrange NOT NULL DEFAULT bt_tx_default(),
  PRIMARY KEY (entl_id, valid, tx),
  EXCLUDE USING gist (entl_id WITH =, valid WITH &&, tx WITH &&)
);
CREATE INDEX entitlements_subject_idx ON entitlements (subject_kind, subject_id, source_id) WHERE upper_inf(tx);

CREATE TABLE access_log (                          -- ENTL-04; partitioned monthly; append-only
  id            bigint GENERATED ALWAYS AS IDENTITY,
  ts            timestamptz NOT NULL,
  user_id       bigint NOT NULL,
  session_id    uuid,
  instrument_id bigint,
  field_id      text NOT NULL,
  source_id     text NOT NULL,
  tier          text NOT NULL,
  usage         text NOT NULL,                     -- display/export/api
  purpose       text NOT NULL,                     -- function code or 'api:data' / 'ws:sub'
  granted       boolean NOT NULL,
  reason        text,                              -- downgrade/deny reason code
  trace_id      text,
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);
CREATE TABLE access_log_default PARTITION OF access_log DEFAULT;
CREATE INDEX access_log_month_idx ON access_log (source_id, tier, user_id, ts);

CREATE TABLE usage_events (                        -- FUNC-04; partitioned monthly
  id         bigint GENERATED ALWAYS AS IDENTITY,
  ts         timestamptz NOT NULL,
  user_id    bigint NOT NULL,
  session_id uuid,
  panel      smallint,
  event_type text NOT NULL,                        -- 'function.launch','function.param','function.export','function.page','function.help','cmd.parse','panel.switch','ws.slow','ws.resync','help.ticket'
  function_code text,
  security_key  text,
  params     jsonb,
  duration_ms int,
  trace_id   text,
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);
CREATE TABLE usage_events_default PARTITION OF usage_events DEFAULT;
CREATE INDEX usage_events_fn_idx ON usage_events (function_code, ts);

CREATE TABLE quota_counters (                      -- API-06
  user_id   bigint NOT NULL REFERENCES users,
  period    text NOT NULL,                         -- '2026-09-15' (day) or '2026-09' (month)
  kind      text NOT NULL CHECK (kind IN ('daily_unique_securities','monthly_data_points','concurrent_subscriptions')),
  count     bigint NOT NULL DEFAULT 0,
  members   bigint[],                              -- unique instrument ids for the daily set (cap 50k)
  PRIMARY KEY (user_id, period, kind)
);
CREATE TABLE quota_limits (
  firm_id bigint REFERENCES firms, user_id bigint REFERENCES users,
  kind text NOT NULL, "limit" bigint NOT NULL,
  CHECK ((firm_id IS NULL) <> (user_id IS NULL))
);
```

---

## 8. Workspaces, watchlists, portfolios, alerts (`0007_workspace_portfolio.sql`)

```sql
CREATE TABLE workspaces (                          -- TERM-05
  workspace_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users,
  firm_id      bigint NOT NULL,
  name         text NOT NULL DEFAULT 'Default',
  is_default   boolean NOT NULL DEFAULT true,
  layout       jsonb NOT NULL,                     -- WorkspaceLayout (CLIENT.md §6): panels[], monitors[], chart settings, focus
  version      int NOT NULL DEFAULT 1,             -- optimistic concurrency
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE watchlists (
  watchlist_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id     bigint NOT NULL REFERENCES users,
  firm_id      bigint NOT NULL,
  name         text NOT NULL,
  columns      jsonb NOT NULL,                     -- [{field:'PX_LAST'}, {formula:'PX_LAST/PX_PREV_CLOSE-1', label:'Chg%'}]
  shared_with  text NOT NULL DEFAULT 'private' CHECK (shared_with IN ('private','firm','users')),
  shared_user_ids bigint[],
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE TABLE watchlist_items (
  watchlist_id  bigint NOT NULL REFERENCES watchlists ON DELETE CASCADE,
  position      int NOT NULL,
  instrument_id bigint,                            -- NULL when formula row
  formula       text,                              -- CHRT-07 formula as a row
  label         text,
  PRIMARY KEY (watchlist_id, position)
);

CREATE TABLE portfolios (                          -- PORT-01/02/07
  portfolio_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id      bigint NOT NULL,
  owner_id     bigint NOT NULL REFERENCES users,
  name         text NOT NULL,
  base_currency text NOT NULL DEFAULT 'USD',
  benchmark_index_id bigint REFERENCES indices,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, name)
);
CREATE TABLE positions (
  portfolio_id  bigint NOT NULL REFERENCES portfolios ON DELETE CASCADE,
  as_of         date NOT NULL,
  instrument_id bigint,                            -- NULL = unresolved (kept for reconciliation report)
  raw_identifier text NOT NULL,                    -- what the upload said
  quantity      numeric(24,6) NOT NULL,
  cost_basis    numeric(24,6),
  currency      text NOT NULL DEFAULT 'USD',
  is_cash       boolean NOT NULL DEFAULT false,
  recon_status  text NOT NULL DEFAULT 'ok' CHECK (recon_status IN ('ok','unresolved','duplicate','price_missing')),
  firm_id       bigint NOT NULL,
  PRIMARY KEY (portfolio_id, as_of, raw_identifier)
);
CREATE TABLE lots (
  lot_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id bigint NOT NULL REFERENCES portfolios ON DELETE CASCADE,
  instrument_id bigint NOT NULL,
  open_date    date NOT NULL,
  quantity     numeric(24,6) NOT NULL,
  unit_cost    numeric(24,8) NOT NULL,
  currency     text NOT NULL,
  firm_id      bigint NOT NULL
);
CREATE TABLE portfolio_uploads (
  upload_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id bigint NOT NULL REFERENCES portfolios,
  uploaded_by bigint NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(),
  filename text, rows_total int, rows_ok int, rows_error int,
  errors jsonb,                                    -- [{row, identifier, reason}]
  firm_id bigint NOT NULL
);

CREATE TABLE chart_annotations (                   -- CHRT-05
  annotation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id      bigint NOT NULL REFERENCES users,
  firm_id       bigint NOT NULL,
  instrument_id bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('trendline','hline','vline','fib','text','rect','regression_channel')),
  anchors       jsonb NOT NULL,                    -- [{t: epoch_ms, v: number}] data coordinates
  style         jsonb NOT NULL DEFAULT '{}'::jsonb,
  text          text,
  shared_with   text NOT NULL DEFAULT 'private',
  created_at    timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chart_annotations_inst_idx ON chart_annotations (instrument_id, owner_id);

CREATE TABLE saved_screens (                       -- EQS / SRCH definitions
  screen_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES users, firm_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EQS','SRCH')),
  name text NOT NULL,
  criteria jsonb NOT NULL,                         -- ScreenCriteria (FUNCTIONS.md EQS/SRCH)
  UNIQUE (owner_id, kind, name)
);
CREATE TABLE saved_searches (                      -- NEWS-07 (news)
  search_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES users, firm_id bigint NOT NULL,
  name text NOT NULL, query jsonb NOT NULL,
  UNIQUE (owner_id, name)
);

CREATE TABLE alerts (                              -- NEWS-07
  alert_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id   bigint NOT NULL REFERENCES users, firm_id bigint NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('price','news','filing','calendar')),
  instrument_id bigint,
  condition  jsonb NOT NULL,                       -- {field:'PX_LAST', op:'>=', value:340} | {query:'tender offer'} | {form:'8-K', items:['5.02']} | {release_id}
  channels   text[] NOT NULL DEFAULT '{inapp}',    -- 'inapp','email','push' (email/push recorded but not delivered in v1)
  status     text NOT NULL DEFAULT 'armed' CHECK (status IN ('armed','triggered','paused','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE alert_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id bigint NOT NULL REFERENCES alerts ON DELETE CASCADE,
  fired_at timestamptz NOT NULL DEFAULT now(),
  payload  jsonb NOT NULL,                         -- {value, news_id, ...}
  delivered_inapp_at timestamptz, acknowledged_at timestamptz
);

CREATE TABLE help_tickets (                        -- TERM-09 second press
  ticket_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users, firm_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  function_code text, security_key text, params jsonb, trace_id text,
  question text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  answer text, answered_by bigint, answered_at timestamptz
);
```

---

## 9. Messaging (`0008_messaging.sql`) — MSG-01..04, MSG-02/REG-01 WORM semantics

```sql
CREATE TABLE rooms (
  room_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('dm','group','firm')),
  name       text,
  firm_id    bigint,                               -- NULL for cross-firm DMs; policy checks per member firm
  created_by bigint NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  disclaimer text
);
CREATE TABLE room_members (
  room_id bigint NOT NULL REFERENCES rooms, user_id bigint NOT NULL REFERENCES users,
  role text NOT NULL DEFAULT 'member', joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE messages (                            -- append-only, hash-chained per room
  message_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id     bigint NOT NULL REFERENCES rooms,
  seq         bigint NOT NULL,                     -- per-room sequence
  sender_id   bigint NOT NULL REFERENCES users,
  sender_firm_id bigint NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  body        text NOT NULL,
  attachments jsonb,                               -- MSG-04: [{kind:'security', key:'AAPL US Equity'}, {kind:'function', code:'GP', params:{...}}, {kind:'chart', annotationIds:[...]}, {kind:'portfolio', id}]
  prev_hash   bytea,                               -- hash of previous message in room
  hash        bytea NOT NULL,                      -- sha256(room_id||seq||sender||sent_at||body||attachments||prev_hash)
  legal_hold  boolean NOT NULL DEFAULT false,
  UNIQUE (room_id, seq)
);
CREATE INDEX messages_room_time_idx ON messages (room_id, sent_at DESC);
CREATE INDEX messages_fts_idx ON messages USING gin (to_tsvector('english', body));

CREATE OR REPLACE FUNCTION messages_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev bytea; nextseq bigint;
BEGIN
  SELECT hash, seq INTO prev, nextseq FROM messages WHERE room_id = NEW.room_id ORDER BY seq DESC LIMIT 1 FOR UPDATE;
  NEW.seq := coalesce(nextseq, 0) + 1;
  NEW.prev_hash := prev;
  NEW.hash := digest(NEW.room_id::text || '|' || NEW.seq::text || '|' || NEW.sender_id::text || '|' || NEW.sent_at::text || '|' || NEW.body || '|' || coalesce(NEW.attachments::text,'') || '|' || coalesce(encode(prev,'hex'),''), 'sha256');
  RETURN NEW;
END $$;
CREATE TRIGGER messages_chain_trg BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_chain();
CREATE RULE messages_no_update AS ON UPDATE TO messages DO INSTEAD NOTHING;
CREATE RULE messages_no_delete AS ON DELETE TO messages DO INSTEAD NOTHING;
-- plus: REVOKE UPDATE, DELETE ON messages FROM terminal_app;

CREATE TABLE legal_holds (
  hold_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id bigint NOT NULL, created_by bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  scope jsonb NOT NULL,                            -- {userIds:[], roomIds:[], from, to}
  released_at timestamptz
);
CREATE TABLE surveillance_lexicon (
  term_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id bigint, pattern text NOT NULL, severity int NOT NULL DEFAULT 2, note text
);
CREATE TABLE surveillance_hits (
  hit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES messages, term_id bigint NOT NULL REFERENCES surveillance_lexicon,
  detected_at timestamptz NOT NULL DEFAULT now(),
  review_status text NOT NULL DEFAULT 'open' CHECK (review_status IN ('open','escalated','cleared')),
  reviewed_by bigint, reviewed_at timestamptz, reviewer_note text
);
CREATE TABLE message_reads (room_id bigint, user_id bigint, last_read_seq bigint NOT NULL, PRIMARY KEY (room_id, user_id));
```

---

## 10. Ops (`0009_ops.sql`)

```sql
CREATE TABLE ingest_runs (
  run_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name   text NOT NULL, provider text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz,
  status     text NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  fetched int, upserted int, skipped int,
  error_class text, error_message text,
  trace_id text
);
CREATE INDEX ingest_runs_job_idx ON ingest_runs (job_name, started_at DESC);

CREATE TABLE data_quality_events (                 -- OPS-03
  dq_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('stale_tick','cross_source_divergence','missing_close','field_population','rate_anomaly','replay_diff')),
  instrument_id bigint, source_id text,
  severity int NOT NULL, details jsonb NOT NULL,
  resolved_at timestamptz
);
CREATE TABLE reconciliation_results (              -- QA-03
  recon_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  instrument_id bigint NOT NULL, bar_date date NOT NULL,
  primary_source text NOT NULL, secondary_source text NOT NULL,
  primary_close double precision, secondary_close double precision,
  diff_bps numeric(10,2), within_tolerance boolean NOT NULL
);
CREATE TABLE status_incidents (                    -- OPS-04
  incident_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  component text NOT NULL, severity text NOT NULL, title text NOT NULL, updates jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE schema_meta (key text PRIMARY KEY, value text NOT NULL);   -- 'field_dictionary_version','concept_map_version'
```

---

## 11. Tenant isolation (`0010_rls.sql`) — PORT-07, SEC-05

```sql
CREATE ROLE terminal_app LOGIN;                   -- server connects as this role (not owner)
GRANT USAGE ON SCHEMA public TO terminal_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO terminal_app;
GRANT UPDATE ON workspaces, watchlists, watchlist_items, portfolios, positions, lots, alerts, alert_events, help_tickets, chart_annotations, saved_screens, saved_searches, sessions, users, quota_counters, message_reads, surveillance_hits, room_members, ingest_runs, data_quality_events, status_incidents TO terminal_app;
GRANT DELETE ON watchlist_items, positions, lots, chart_annotations, saved_screens, saved_searches, alerts TO terminal_app;
-- bitemporal tables: UPDATE only via bt_close (guarded by trigger); grant UPDATE(tx)
GRANT UPDATE (tx) ON instruments, issues, issuers, listings, identifiers, govt_terms, corporate_actions, entitlements, licence_registry, index_memberships, instrument_classifications, fundamentals_std, entities TO terminal_app;

ALTER TABLE workspaces, watchlists, watchlist_items, portfolios, positions, lots, portfolio_uploads,
            chart_annotations, saved_screens, saved_searches, alerts, alert_events, help_tickets ENABLE ROW LEVEL SECURITY;
-- watchlist_items has no firm_id: policy via join
CREATE POLICY firm_isolation ON portfolios USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON positions  USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON lots       USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON portfolio_uploads USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON workspaces USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON watchlists USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON watchlist_items USING (EXISTS (SELECT 1 FROM watchlists w WHERE w.watchlist_id = watchlist_items.watchlist_id AND w.firm_id = current_setting('app.firm_id')::bigint));
CREATE POLICY firm_isolation ON chart_annotations USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON saved_screens USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON saved_searches USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON alerts USING (firm_id = current_setting('app.firm_id')::bigint);
CREATE POLICY firm_isolation ON alert_events USING (EXISTS (SELECT 1 FROM alerts a WHERE a.alert_id = alert_events.alert_id AND a.firm_id = current_setting('app.firm_id')::bigint));
CREATE POLICY firm_isolation ON help_tickets USING (firm_id = current_setting('app.firm_id')::bigint);
-- messages: members only (cross-firm rooms allowed)
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY room_member ON messages USING (EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = messages.room_id AND m.user_id = current_setting('app.user_id')::bigint AND m.left_at IS NULL) OR current_setting('app.role', true) = 'compliance');
```

The server sets `SET LOCAL app.firm_id = $1; SET LOCAL app.user_id = $2; SET LOCAL app.role = $3`
at the start of every request transaction (`db/client.ts#withRequestTx`). Ingest jobs run as the
owner role with `app.firm_id` unset; policies then deny (no tenant data is touched by ingest).

---

## 12. Index summary (hot paths)

| Query (owner) | Index |
| --- | --- |
| Resolve `AAPL US Equity` → instrument (every launch) | `instruments_key_idx (ticker, market_sector, exch_code) WHERE upper_inf(tx)` |
| Resolve identifier (FIGI/ISIN/CUSIP/OCC) | `identifiers_lookup_idx (scheme, value) WHERE upper_inf(tx)` |
| Autocomplete server fallback | `instruments_ticker_trgm`, `instruments_name_trgm`, `issuers_name_trgm`, `econ_series_name_trgm` |
| HP/GP 1y daily bars (< 200 ms p95) | `bars_1d` PK `(instrument_id, bar_date)` range scan ≈ 252 rows |
| GIP intraday | `bars_1m` PK, partition pruning by `ts` |
| Tick query one session | `quote_ticks` PK + daily partition |
| OMON chain | `option_terms_chain_idx (underlying_id, expiry, strike)` + `option_chain_snapshots` PK latest per option (DISTINCT ON) |
| FA PIT | `xbrl_facts_pit_idx (cik, concept, period_end, filed_at DESC)` |
| CN / TOP | `news_entity_links_entity_idx`, `news_items_published_idx`, `news_items_fts_idx` |
| MEMB | `index_memberships_idx (index_id, as_of DESC)` |
| Entitlements | `entitlements_subject_idx` |
| Declarations | `access_log_month_idx (source_id, tier, user_id, ts)` |
| Curves | `curve_points_latest_idx` |

---

## 13. Seed strategy and volumes

`npm run db:seed` (`packages/server/src/db/seed/index.ts`) is deterministic and offline; it reads
only `fixtures/` (replay store + `fixtures/seed/*.json`). Order:

| Step | Source fixture(s) | Produces | Rows (approx.) |
| --- | --- | --- | --- |
| 1 licences/sources/fields | `fixtures/seed/licences.json`, generated `fields.json` | `licence_registry`, `sources`, `field_licence` | 18 licences, 18 sources, ~140 field rows |
| 2 calendars/exchanges | rule generators in `core/calendars` | `calendars`, `calendar_holidays` (1990–2040), `exchanges` | 5 calendars, ~1,200 holidays, 12 exchanges |
| 3 universe | `sec-company-tickers.json` (10,422), `cboe-symbol-book.json` (35,618), `openfigi-map`/`openfigi-search` replay entries | `issuers`, `issues`, `instruments`, `listings`, `md_lines`, `identifiers` | ≈ 38k instruments (dedup on ticker; Cboe futures-like symbols such as `A2RZ1` classified `future`/inactive), 10.4k issuers with CIK, ≈ 45k listings, ≈ 80k md_lines, ≈ 120k identifiers |
| 4 indices | `sec-nport-SPY-primary_doc.xml` (504 holdings as of 2026-06-30), `ssga-spy-holdings.xlsx` (as of 2026-09-14), `wiki-sp500.html` (GICS sectors, date added, CIK) | `indices` (SPX, NDX, RTY, INDU, VIX, UKX, DAX, NKY, SX5E, BUK100P), `index_memberships` (SPX two as-of dates), `instrument_classifications` (GICS) | 10 indices, ≈ 1,010 membership rows, 503 classifications |
| 5 govt | `treasury-bills.xml` CUSIP/maturity fields + synthetic on-the-run set from `fixtures/seed/treasuries.json` | `instruments` (govt), `govt_terms`, `identifiers` (CUSIP) | 7 bills + 7 notes/bonds |
| 6 options | `cboe-options` (3,510 AAPL contracts) | `instruments` (option), `option_terms`, `option_chain_snapshots` | 3,510 |
| 7 bars | `yahoo-chart-events` (AAPL 5y 1d + 20 dividends), `yahoo-chart-AAPL-max-1d`, `yahoo-chart-AAPL-1d-1m`, `yahoo-chart-SPX-5d-5m`, `yahoo-fx`, `yahoo-ftse`, `yahoo-bond` | `bars_1d`, `bars_1m`, `corporate_actions` | AAPL 1,255 daily + 317 1-min; SPX 377 5-min; FX/FTSE/TNX intraday |
| 7b synthetic bars (dev only, `SEED_SYNTHETIC=1`) | seeded PRNG walk anchored to `quote_ticks` prev_close | `bars_1d` for S&P 500 members, 5y; `source_id='synthetic'`, badge shown in UI | 503 × 1,260 ≈ 634k |
| 8 quotes | `cboe-quote-AAPL.json`, `cboe-spx`, `cboe-vix`, `cboe-eu-indices` | `quote_ticks` (plant warm start) | 4 |
| 9 rates/curves | `nyfed-all`, `nyfed-sofr`, `nyfed-effr.json`, `fed-h15.csv`, `fred-DGS10.csv` (16k rows since 1962), `treasury-xml2` (9 days), `treasury-bills.xml` | `rates_observations`, `curves`, `curve_points` | ≈ 16.3k rate obs, 5 curves, ≈ 250 curve points |
| 10 FX | `frankfurter` | `fx_rates` | 29 |
| 11 econ | `bls-cpi.json`, `worldbank`, `imf-weo.json`, `fred-cal`, `fred-releases.html`, `bls-schedule.html` | `econ_series`, `econ_observations`, `econ_releases`, `econ_release_events`, `fomc_meetings` (from `fixtures/seed/fomc.json`) | ≈ 150 series, ≈ 16.5k obs, ≈ 60 releases, ≈ 80 events, 8 meetings |
| 12 news | `bbg-rss-*` (5 × 20), `fed-press-rss.xml`, `sec-8k-atom.xml` (40) | `news_items`, `news_entity_links`, `news_topics` | ≈ 160 items, ≈ 200 links |
| 13 fundamentals | `sec-companyfacts-AAPL.json` (503 concepts), `sec-submissions-AAPL.json` (1,000 filings), `sec-spy-submissions.json`, `sec-frames-assets.json` (6,264 companies' Assets CY2024Q4I) | `xbrl_facts`, `filings`, `fundamentals_std` (AAPL), `concept_map` | ≈ 25k AAPL facts + 6.3k frame facts; 1.0k filings |
| 14 short interest | `finra-trace` (1 row) | `short_interest` | 1 |
| 15 crypto | `coingecko-simple.json` | `instruments` (BTC, ETH crypto), `quote_ticks` | 2 |
| 16 users | `fixtures/seed/users.json` | `firms` (Demo Desk, Second Firm for isolation tests), `users` (pm, analyst, rates, compliance), `entitlements` (firm: all sources delayed/eod display+export+api), `quota_limits` | 2 firms, 5 users, ≈ 40 entitlement rows |
| 17 workspace | `fixtures/seed/workspace-default.json` | default 4-panel workspace (WEI / TOP / GP SPX / W "Core") per user, one watchlist | 4 workspaces |

Production-style growth (for capacity planning, plain Postgres): `bars_1d` +1.5k rows/day;
`bars_1m` +120k rows/day (300 actively subscribed names); `quote_ticks` +700k rows/day at a 10 s
poll (30-day retention ≈ 21M rows, ≈ 2.5 GB); `access_log` ≈ 50 rows per function launch,
≈ 200k/day for 50 users (monthly partitions, ≈ 6M rows/month). All within a single Postgres 14
instance with default settings plus `shared_buffers = 2GB`, `work_mem = 64MB`.
