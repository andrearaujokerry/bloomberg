-- migration: 0015_roles_rls_worm.sql
-- 15.a Role (cluster-wide; bloomberg_dev and bloomberg_test share it, so create only when absent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'terminal_app') THEN
    CREATE ROLE terminal_app LOGIN;             -- password set by ops: ALTER ROLE terminal_app PASSWORD '…'; DATABASE_URL uses it
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO terminal_app', current_database());   -- bloomberg_dev or bloomberg_test
END $$;
GRANT USAGE ON SCHEMA public TO terminal_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO terminal_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO terminal_app;          -- views included (SELECT)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO terminal_app;     -- future partitions
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO terminal_app;

-- 15.b Mutable application tables: full UPDATE, DELETE where the product deletes
GRANT UPDATE ON firms, users, user_credentials, sessions, api_keys, entitlement_grants, quota_limits, quota_counters,
                usage_declarations, workspaces, watchlists, watchlist_items, portfolios, portfolio_imports, positions, lots,
                chart_annotations, saved_searches, alerts, alert_events, rooms, room_members, message_reads, legal_holds,
                surveillance_lexicon, surveillance_hits, message_reviews, help_tickets, ingest_runs, dq_events, data_exceptions,
                status_incidents, schema_meta, config_versions, quote_snapshots, eod_snapshots,
                econ_observations, rate_fixings, curve_points, econ_release_events, econ_series, econ_releases, fomc_meetings,
                filings, xbrl_frames, bars_daily, bars_intraday, fx_rates, short_interest, etf_holdings, calendar_holidays,
                calendar_sessions, calendars, exchanges, classification_codes, classification_schemes, indices, issuer_aliases,
                topics, field_licence,
                news_items, news_entity_links, vol_surfaces
  TO terminal_app;
-- news_items / news_entity_links: NEWS-01/NEWS-02 re-ingest is an upsert on (source_id, provider_guid) — a correction
-- rewrites headline/summary/is_correction, and a later linking run rewrites confidence/method on an existing link.
-- vol_surfaces: ANAL-04 re-fits the same (underlying_instrument_id, as_of, expiry) key. Without UPDATE all three writers
-- raise "permission denied for table" on their second run, which is exactly the idempotency the replay tests assert.
GRANT DELETE ON watchlist_items, watchlists, positions, lots, chart_annotations, saved_searches, alerts, alert_events,
                room_members, message_reads, quota_instruments_seen, quota_counters, field_licence, issuer_aliases,
                calendar_holidays, calendar_sessions, dq_events
  TO terminal_app;

-- 15.c Bitemporal tables: UPDATE is allowed (the bt_guard trigger restricts it to closing tx_to); DELETE never.
GRANT UPDATE ON licence_registry, issuers, issues, instruments, listings, md_lines, identifiers, govt_terms, option_terms,
                future_terms, fund_terms, index_terms, fx_terms, rate_terms, entity_classifications, index_members, people,
                entity_relations, corporate_actions
  TO terminal_app;
-- (no DELETE grant on any of them; the default grant above is SELECT, INSERT only)

-- 15.d WORM tables (REG-01, MSG-02, ENTL-04, DATA-10): no UPDATE, no DELETE, plus triggers as defence in depth against the owner role
CREATE FUNCTION worm_block() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'table % is append-only (WORM)', TG_TABLE_NAME; END $$;
CREATE TRIGGER messages_worm     BEFORE UPDATE OR DELETE ON messages     FOR EACH ROW EXECUTE FUNCTION worm_block();
CREATE TRIGGER access_log_worm   BEFORE UPDATE OR DELETE ON access_log   FOR EACH ROW EXECUTE FUNCTION worm_block();   -- BEFORE row triggers on partitioned tables: PG 13+
CREATE TRIGGER provenance_worm   BEFORE UPDATE OR DELETE ON provenance   FOR EACH ROW EXECUTE FUNCTION worm_block();
CREATE TRIGGER usage_events_worm BEFORE UPDATE OR DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION worm_block();
CREATE TRIGGER xbrl_facts_worm   BEFORE UPDATE OR DELETE ON xbrl_facts   FOR EACH ROW EXECUTE FUNCTION worm_block();   -- STOR-06: restatements are new rows
-- Retention drops happen at partition level (DROP TABLE <partition>) by the owner role and never touch rows under an open legal hold.

-- 15.d.1 Partition maintenance role (STOR-05, STOR-07, OPS-03)
-- `terminal_app` holds USAGE on the schema plus SELECT/INSERT (and the UPDATE/DELETE lists above). That is deliberately
-- not enough to maintain partitions: CREATE TABLE needs CREATE on the schema, DROP TABLE needs ownership of the
-- partition, and ATTACH/DETACH needs ownership of the parent. Granting terminal_app ownership of the partitioned
-- parents would also hand it the power to disable the 15.d WORM triggers on access_log and usage_events, which is the
-- one thing those triggers exist to prevent. So maintenance gets its own role, which owns the six partitioned parents:
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'terminal_maint') THEN
    CREATE ROLE terminal_maint LOGIN;          -- DATABASE_URL_MAINT; password set by ops
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO terminal_maint', current_database());
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO terminal_maint;
ALTER TABLE bars_daily    OWNER TO terminal_maint;
ALTER TABLE bars_intraday OWNER TO terminal_maint;
ALTER TABLE quote_ticks   OWNER TO terminal_maint;
ALTER TABLE option_quotes OWNER TO terminal_maint;
ALTER TABLE access_log    OWNER TO terminal_maint;
ALTER TABLE usage_events  OWNER TO terminal_maint;
-- ownership moves only the six parents (and, by inheritance of the OWNER on new children, every partition
-- terminal_maint creates); the 0016 partitions are re-owned in the same statement block:
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
           JOIN pg_class parent ON parent.oid = i.inhparent
           WHERE parent.relname IN ('bars_daily','bars_intraday','quote_ticks','option_quotes','access_log','usage_events')
  LOOP EXECUTE format('ALTER TABLE %I OWNER TO terminal_maint', p.relname); END LOOP;
END $$;
-- terminal_app keeps exactly the access it had (ownership changes do not revoke grants, but the default privileges
-- above are attached to the migration owner, so restate them for the new owner's future partitions):
ALTER DEFAULT PRIVILEGES FOR ROLE terminal_maint IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO terminal_app;
GRANT SELECT, INSERT ON bars_daily, bars_intraday, quote_ticks, option_quotes, access_log, usage_events TO terminal_app;
GRANT UPDATE ON bars_daily, bars_intraday TO terminal_app;                 -- as listed in 15.b; access_log/usage_events stay WORM
-- The WORM triggers of 15.d still fire for terminal_maint: DROP TABLE on a partition is DDL, not a row UPDATE/DELETE,
-- so retention drops work while row-level rewrites remain blocked for every role.
-- Consequence for the server (§15.1): `db/client.ts` opens a second, single-connection pool on DATABASE_URL_MAINT used
-- only by `db/partitions.ts#ensurePartitions` / `#dropExpired` and by `retentionPurge`. Every other statement in the
-- process runs on the terminal_app pool. On PG 14 the legacy PUBLIC CREATE grant on schema public would mask half of
-- this in development and fail only in a hardened deployment, so the split is made explicit here rather than discovered.

-- 15.e Per-room hash chain and sequence (MSG-02). The advisory lock serialises concurrent sends into one room.
CREATE FUNCTION messages_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev bytea; last_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('room:' || NEW.room_id::text));
  SELECT hash, seq INTO prev, last_seq FROM messages WHERE room_id = NEW.room_id ORDER BY seq DESC LIMIT 1;
  NEW.seq       := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := prev;
  NEW.hash      := digest(coalesce(prev, '\x'::bytea)
                          || convert_to(NEW.room_id::text || '|' || NEW.seq::text || '|' || NEW.sender_user_id::text || '|'
                                        || to_char(NEW.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
                                        || NEW.body || '|' || NEW.attachments::text, 'UTF8'),
                          'sha256');
  RETURN NEW;
END $$;
CREATE TRIGGER messages_chain_trg BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_chain();

-- 15.f Tenant isolation (PORT-07, SEC-05). db/client.ts sets app.user_id / app.firm_id / app.role per request transaction.
-- FORCE makes the policies apply to the table owner as well, so even migrations/seed/ingest cannot read tenant data
-- without a firm context. A missing context (ingest jobs, the newsroom role) yields zero rows and rejects writes.
ALTER TABLE portfolios        ENABLE ROW LEVEL SECURITY; ALTER TABLE portfolios        FORCE ROW LEVEL SECURITY;
ALTER TABLE positions         ENABLE ROW LEVEL SECURITY; ALTER TABLE positions         FORCE ROW LEVEL SECURITY;
ALTER TABLE lots              ENABLE ROW LEVEL SECURITY; ALTER TABLE lots              FORCE ROW LEVEL SECURITY;
ALTER TABLE portfolio_imports ENABLE ROW LEVEL SECURITY; ALTER TABLE portfolio_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces        ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_searches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE help_tickets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY; ALTER TABLE messages          FORCE ROW LEVEL SECURITY;
ALTER TABLE rooms             ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reads     ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_holds       ENABLE ROW LEVEL SECURITY;
ALTER TABLE surveillance_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reviews   ENABLE ROW LEVEL SECURITY;

CREATE POLICY portfolios_tenant ON portfolios USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());
CREATE POLICY positions_tenant  ON positions  USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());
CREATE POLICY lots_tenant       ON lots       USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());
CREATE POLICY imports_tenant    ON portfolio_imports USING (firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());
CREATE POLICY workspaces_owner  ON workspaces USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY watchlists_scope  ON watchlists
  USING (owner_user_id = app_user_id()
         OR (firm_id = app_firm_id() AND (shared_scope = 'firm' OR (shared_scope = 'users' AND app_user_id() = ANY (shared_user_ids)))))
  WITH CHECK (owner_user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY watchlist_items_scope ON watchlist_items
  USING (EXISTS (SELECT 1 FROM watchlists w WHERE w.watchlist_id = watchlist_items.watchlist_id))      -- delegates to watchlists' policy
  WITH CHECK (EXISTS (SELECT 1 FROM watchlists w WHERE w.watchlist_id = watchlist_items.watchlist_id AND w.owner_user_id = app_user_id()));
CREATE POLICY annotations_scope ON chart_annotations
  USING (owner_user_id = app_user_id()
         OR (firm_id = app_firm_id() AND (shared_scope = 'firm' OR (shared_scope = 'users' AND app_user_id() = ANY (shared_user_ids)))))
  WITH CHECK (owner_user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY saved_searches_owner ON saved_searches USING (owner_user_id = app_user_id()) WITH CHECK (owner_user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY alerts_owner         ON alerts         USING (owner_user_id = app_user_id()) WITH CHECK (owner_user_id = app_user_id() AND firm_id = app_firm_id());
CREATE POLICY alert_events_owner   ON alert_events   USING (EXISTS (SELECT 1 FROM alerts a WHERE a.alert_id = alert_events.alert_id))
                                                     WITH CHECK (firm_id = app_firm_id());
CREATE POLICY help_tickets_scope   ON help_tickets   USING (user_id = app_user_id() OR (firm_id = app_firm_id() AND app_role() IN ('admin','helpdesk')))
                                                     WITH CHECK (user_id = app_user_id() AND firm_id = app_firm_id());
-- Messaging: members read; compliance/supervisors of a member's firm read for review (MSG-02); the newsroom role never has a firm context (SEC-06).
-- A policy on room_members cannot sub-select room_members (Postgres raises "infinite recursion detected in policy"), so
-- membership is answered by SECURITY DEFINER helpers owned by the migration owner, which bypass the (non-FORCEd) policy.
CREATE FUNCTION is_room_member(p_room_id bigint, p_user_id bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = p_room_id AND m.user_id = p_user_id AND m.left_at IS NULL) $$;
CREATE FUNCTION room_has_firm(p_room_id bigint, p_firm_id bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM room_members m JOIN users u ON u.user_id = m.user_id WHERE m.room_id = p_room_id AND u.firm_id = p_firm_id) $$;
REVOKE ALL ON FUNCTION is_room_member(bigint, bigint), room_has_firm(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_room_member(bigint, bigint), room_has_firm(bigint, bigint) TO terminal_app;

CREATE POLICY rooms_member ON rooms
  USING (is_room_member(rooms.room_id, app_user_id())
         OR (app_role() = 'compliance' AND room_has_firm(rooms.room_id, app_firm_id())))
  WITH CHECK (created_by = app_user_id());
CREATE POLICY room_members_visible ON room_members
  USING (user_id = app_user_id()
         OR is_room_member(room_members.room_id, app_user_id())
         OR (app_role() = 'compliance' AND room_has_firm(room_members.room_id, app_firm_id())))
  WITH CHECK (app_user_id() IS NOT NULL);
CREATE POLICY messages_member ON messages
  USING (is_room_member(messages.room_id, app_user_id())
         OR (app_role() = 'compliance' AND room_has_firm(messages.room_id, app_firm_id())))
  WITH CHECK (sender_user_id = app_user_id() AND sender_firm_id = app_firm_id() AND is_room_member(messages.room_id, app_user_id()));
CREATE POLICY message_reads_owner ON message_reads USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY legal_holds_firm    ON legal_holds    USING (firm_id = app_firm_id() AND app_role() IN ('compliance','admin')) WITH CHECK (firm_id = app_firm_id() AND app_role() IN ('compliance','admin'));
CREATE POLICY surveillance_hits_compliance ON surveillance_hits USING (app_role() = 'compliance') WITH CHECK (app_role() = 'compliance');
CREATE POLICY message_reviews_compliance   ON message_reviews   USING (app_role() = 'compliance') WITH CHECK (app_role() = 'compliance');

-- 15.g Surveillance and hash-chain writers run inside the sender's transaction (messaging/service.ts), so no policy bypass is needed.
