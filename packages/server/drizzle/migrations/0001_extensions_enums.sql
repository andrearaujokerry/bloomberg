-- migration: 0001_extensions_enums.sql
CREATE EXTENSION IF NOT EXISTS btree_gist;     -- '=' on scalar keys inside gist exclusion constraints
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- trigram indexes for autocomplete fallback and headline search
CREATE EXTENSION IF NOT EXISTS pgcrypto;       -- digest() for the message hash chain, session token hashing
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";    -- uuid_generate_v4() kept available; gen_random_uuid() is core in PG14

CREATE TYPE asset_class   AS ENUM ('equity','etf','index','fx','govt','option','future','crypto','rate','econ');
CREATE TYPE market_sector AS ENUM ('Equity','Index','Curncy','Govt','Corp','Comdty','Mtge','Muni','Pfd','M-Mkt','Crypto');
CREATE TYPE id_scheme     AS ENUM ('FIGI','COMPOSITE_FIGI','SHARE_CLASS_FIGI','ISIN','CUSIP','SEDOL','RIC','TICKER_EXCH',
                                   'LEI','MIC','CIK','OCC','PROVIDER_SYMBOL','SERIES_CODE');
CREATE TYPE tier          AS ENUM ('eod','delayed','realtime');            -- declared in rank order: eod < delayed < realtime
CREATE TYPE usage_type    AS ENUM ('display','export','api');
CREATE TYPE field_class   AS ENUM ('price','reference','fundamental','econ','news','analytic','derived','portfolio');
CREATE TYPE entl_decision AS ENUM ('allow','downgrade','deny');
CREATE TYPE ca_type       AS ENUM ('cash_dividend','special_dividend','stock_dividend','split','reverse_split','spinoff',
                                   'merger','tender','rights','call','conversion','name_change','ticker_change',
                                   'delisting','capital_return');
CREATE TYPE ca_status     AS ENUM ('estimated','announced','confirmed','paid','cancelled');
CREATE TYPE entity_kind   AS ENUM ('issuer','issue','instrument','listing','person','topic');
CREATE TYPE session_state AS ENUM ('pre','open','auction','halted','closed','post','unknown');

-- Tier ordering for the entitlement evaluator and tests (min(cap, firm, user) is min(tier_rank)).
CREATE FUNCTION tier_rank(t tier) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE t WHEN 'eod' THEN 0 WHEN 'delayed' THEN 1 WHEN 'realtime' THEN 2 END $$;

-- 1.1.a The as-of predicate (REF-03). IMMUTABLE so it is inlined by the planner and usable in partial indexes.
CREATE FUNCTION bt_as_of(vf timestamptz, vt timestamptz, tf timestamptz, tt timestamptz,
                         valid_at timestamptz, known_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT vf <= valid_at AND vt > valid_at AND tf <= known_at AND tt > known_at
$$;

-- 1.1.b Guard: application code may UPDATE a bitemporal row only to close tx_to, exactly once.
CREATE FUNCTION bt_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tx_to <> 'infinity' THEN
    RAISE EXCEPTION 'bitemporal row % in % is already closed', OLD.version_id, TG_TABLE_NAME;
  END IF;
  IF NEW.tx_to = 'infinity' THEN
    RAISE EXCEPTION 'bitemporal rows in % are immutable; insert a new version', TG_TABLE_NAME;
  END IF;
  IF NEW.tx_to <= OLD.tx_from THEN
    RAISE EXCEPTION 'tx_to must be after tx_from';
  END IF;
  -- every column except tx_to must be unchanged
  IF (to_jsonb(NEW) - 'tx_to') <> (to_jsonb(OLD) - 'tx_to') THEN
    RAISE EXCEPTION 'only tx_to may change on a bitemporal row in %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

-- 1.1.c Generic "close current versions overlapping a valid range" used by writeVersion() (one implementation
-- for every bitemporal table; EXECUTE with format(%I) so the table/key are identifiers, values are parameters).
-- p_now defaults to clock_timestamp(), NOT now(): now() is transaction start, so a version inserted and then closed
-- in one transaction would get tx_to = tx_from and raise 'tx_to must be after tx_from' (bt_guard_update) as well as
-- violating <table>_tx_range. clock_timestamp() advances within the transaction, so two writes to one key in one
-- transaction still order. Callers that are backdating (a historical correction, a seed) pass p_now explicitly.
CREATE FUNCTION bt_close_tx(tbl regclass, key_col text, key_val bigint, p_valid_from timestamptz, p_valid_to timestamptz,
                            p_now timestamptz DEFAULT clock_timestamp())
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  EXECUTE format(
    'UPDATE %s SET tx_to = $4 WHERE %I = $1 AND tx_to = ''infinity''
       AND tstzrange(valid_from, valid_to, ''[)'') && tstzrange($2, $3, ''[)'')', tbl, key_col)
    USING key_val, p_valid_from, p_valid_to, p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- 1.1.d Session context helpers used by every RLS policy (§15). NULLIF guards the '' that current_setting()
-- returns for a custom GUC that was set earlier in the session and has since gone out of scope.
CREATE FUNCTION app_user_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::bigint $$;
CREATE FUNCTION app_firm_id() RETURNS bigint LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.firm_id', true), '')::bigint $$;
CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'none') $$;
