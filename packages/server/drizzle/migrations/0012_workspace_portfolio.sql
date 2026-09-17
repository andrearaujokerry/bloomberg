-- migration: 0012_workspace_portfolio.sql
CREATE TABLE workspaces (                       -- TERM-05: the whole desk, server-side
  workspace_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(user_id),
  firm_id      bigint NOT NULL REFERENCES firms(firm_id),
  name         text NOT NULL DEFAULT 'default',
  is_active    boolean NOT NULL DEFAULT true,
  layout       jsonb NOT NULL,                  -- WorkspaceLayout (API.md): panels[{id, frameStack[{security, fn, params}], history}], monitors, chart settings, focus
  version      int NOT NULL DEFAULT 1,          -- optimistic concurrency: PUT must send the version it read (409 otherwise)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE UNIQUE INDEX workspaces_active_uniq ON workspaces (user_id) WHERE is_active;
CREATE TRIGGER workspaces_updated BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE watchlists (                       -- W: user-defined, shareable, computed columns
  watchlist_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id   bigint NOT NULL REFERENCES users(user_id),
  firm_id         bigint NOT NULL REFERENCES firms(firm_id),
  name            text NOT NULL,
  columns         jsonb NOT NULL,               -- [{id:'PX_LAST'} | {id:'c1', formula:'PX_LAST/PX_CLOSE_1D-1', label:'Chg', decimals:2}]  (CHRT-07 formula language)
  sort            jsonb NOT NULL DEFAULT '[]',
  group_by        text,
  shared_scope    text NOT NULL DEFAULT 'private' CHECK (shared_scope IN ('private','firm','users')),
  shared_user_ids bigint[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);
CREATE TRIGGER watchlists_updated BEFORE UPDATE ON watchlists FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE watchlist_items (
  watchlist_id  bigint NOT NULL REFERENCES watchlists(watchlist_id) ON DELETE CASCADE,
  position      int NOT NULL,
  instrument_id bigint,                         -- NULL when the row is a formula/basket
  formula       text,                           -- CHRT-07 computed series as a row ('RATIO(AAPL US Equity, SPX Index)')
  label         text,
  note          text,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, position),
  CONSTRAINT watchlist_items_kind CHECK ((instrument_id IS NULL) <> (formula IS NULL))
);
CREATE INDEX watchlist_items_instrument_idx ON watchlist_items (instrument_id) WHERE instrument_id IS NOT NULL;   -- hotset.ts: watchlist members of connected users

CREATE TABLE portfolios (                       -- PORT-07: strictly tenant-isolated (RLS FORCE in §15)
  portfolio_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id                 bigint NOT NULL REFERENCES firms(firm_id),
  owner_user_id           bigint NOT NULL REFERENCES users(user_id),
  name                    text NOT NULL,
  base_currency           char(3) NOT NULL DEFAULT 'USD',
  benchmark_instrument_id bigint,               -- SPX Index / SPY
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, name)
);
CREATE TRIGGER portfolios_updated BEFORE UPDATE ON portfolios FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE portfolio_imports (                -- PORT-01: upload / file drop / API with reconciliation report
  import_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id   bigint NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
  firm_id        bigint NOT NULL,
  uploaded_by    bigint NOT NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  channel        text NOT NULL CHECK (channel IN ('upload','file_drop','api','manual')),
  filename       text,
  as_of_date     date NOT NULL,
  rows_total     int NOT NULL DEFAULT 0,
  rows_ok        int NOT NULL DEFAULT 0,
  rows_error     int NOT NULL DEFAULT 0,
  errors         jsonb NOT NULL DEFAULT '[]',   -- [{row, identifier, column, reason}]
  reconciliation jsonb NOT NULL DEFAULT '{}',   -- {matched, added, removed, quantityDiffs:[{instrumentId, before, after}]}
  status         text NOT NULL CHECK (status IN ('accepted','partial','rejected')),
  provenance_id  bigint REFERENCES provenance(provenance_id)   -- source 'internal.user'
);

CREATE TABLE positions (                        -- PORT-02: multi-asset, multi-currency; one row per (portfolio, lot, as-of)
  position_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id   bigint NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
  firm_id        bigint NOT NULL,               -- denormalised for RLS
  as_of_date     date NOT NULL,
  instrument_id  bigint,                        -- NULL = cash line or unresolved identifier
  raw_identifier text NOT NULL,                 -- what the upload said ('AAPL US', 'US0378331005', 'USD')
  is_cash        boolean NOT NULL DEFAULT false,
  cash_currency  char(3),
  lot_id         text NOT NULL DEFAULT 'default',
  quantity       numeric(24,8) NOT NULL,
  cost_price     numeric(18,6),
  cost_currency  char(3),
  trade_date     date,
  settle_date    date,
  accrued        numeric(18,6) NOT NULL DEFAULT 0,
  recon_status   text NOT NULL DEFAULT 'ok' CHECK (recon_status IN ('ok','unresolved','duplicate','price_missing')),
  import_id      bigint REFERENCES portfolio_imports(import_id),
  UNIQUE (portfolio_id, as_of_date, raw_identifier, lot_id)
);
CREATE INDEX positions_portfolio_idx ON positions (portfolio_id, as_of_date DESC);

CREATE TABLE lots (                             -- PORT-02 lot-level cost basis (open lots; positions are the as-of snapshot)
  lot_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id  bigint NOT NULL REFERENCES portfolios(portfolio_id) ON DELETE CASCADE,
  firm_id       bigint NOT NULL,
  instrument_id bigint NOT NULL,
  open_date     date NOT NULL,
  quantity      numeric(24,8) NOT NULL,
  unit_cost     numeric(24,8) NOT NULL,
  currency      char(3) NOT NULL,
  closed_date   date,
  external_ref  text
);
CREATE INDEX lots_portfolio_idx ON lots (portfolio_id, instrument_id) WHERE closed_date IS NULL;

CREATE TABLE chart_annotations (                -- CHRT-05: anchored in data coordinates, shareable
  annotation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES users(user_id),
  firm_id       bigint NOT NULL,
  instrument_id bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('trendline','hline','vline','fib','text','regression_channel','rect')),
  anchors       jsonb NOT NULL,                 -- [{t: epoch_ms, v: number}] (regression: {t0, t1, stdev})
  style         jsonb NOT NULL DEFAULT '{}',
  label         text,
  shared_scope  text NOT NULL DEFAULT 'private' CHECK (shared_scope IN ('private','firm','users')),
  shared_user_ids bigint[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chart_annotations_instrument_idx ON chart_annotations (instrument_id, owner_user_id);
CREATE TRIGGER chart_annotations_updated BEFORE UPDATE ON chart_annotations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE saved_searches (                   -- NEWS-07 saved news searches, EQS / SRCH screen definitions
  search_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES users(user_id),
  firm_id       bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('news','eqs','srch')),
  name          text NOT NULL,
  query         jsonb NOT NULL,                 -- news: {text, instrumentIds[], topics[], feeds[]}; eqs/srch: ScreenCriteria (FUNCTIONS.md)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, kind, name)
);
CREATE TRIGGER saved_searches_updated BEFORE UPDATE ON saved_searches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alerts (                           -- NEWS-07: user-defined triggers on prices, news, filings, calendar events
  alert_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES users(user_id),
  firm_id       bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('price','news','filing','calendar')),
  instrument_id bigint,                         -- price alerts (evaluated on plant deltas)
  condition     jsonb NOT NULL,                 -- price: {field:'PX_LAST', op:'>='|'<='|'crosses', value}; news: {savedSearchId}|{query}; filing: {ciks[], forms[], items[]}; calendar: {releaseId, minutesBefore}
  delivery      text[] NOT NULL DEFAULT '{inapp}',   -- 'inapp' | 'email' | 'push' (email/push are recorded intents in v1)
  status        text NOT NULL DEFAULT 'armed' CHECK (status IN ('armed','paused','fired','deleted')),
  one_shot      boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_fired_at timestamptz
);
CREATE INDEX alerts_armed_price_idx ON alerts (instrument_id) WHERE status = 'armed' AND kind = 'price';
CREATE INDEX alerts_owner_idx       ON alerts (owner_user_id) WHERE status <> 'deleted';

CREATE TABLE alert_events (
  event_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id        bigint NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
  firm_id         bigint NOT NULL,
  fired_at        timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL,               -- {value, newsId, accessionNo, eventId, provenanceId}
  delivered       jsonb NOT NULL DEFAULT '{}',  -- {inapp: ts, email: null, push: null}
  acknowledged_at timestamptz
);
CREATE INDEX alert_events_alert_idx ON alert_events (alert_id, fired_at DESC);
