-- 0017 — WP-09 integration round 1: the database-side half of MSG-02/03, REG-01 and NEWS-07.
--
-- Everything here closes a hole an adversarial audit opened against the code shipped in 0013/0015.
-- Each section names the hole and the exact reproduction, because a policy nobody can re-derive is
-- a policy the next migration silently widens again.
--
--   17.a  REG-01's seven-year retention floor had no CHECK: the room creator could
--         `UPDATE rooms SET retention_days = 1` as terminal_app (rooms_member's WITH CHECK is
--         `created_by = app_user_id()` and 15.b grants UPDATE on rooms). The service refused it;
--         nothing else did.
--   17.b  `INSERT INTO rooms … RETURNING room_id` raised 42501 under terminal_app: the RETURNING
--         row has to satisfy rooms_member's USING clause, and the creator is not a member yet
--         (the room_members insert comes after). POST /api/v1/rooms and POST /api/v1/help/tickets
--         therefore 500 wherever RLS applies.
--   17.c  room_members' WITH CHECK was `app_user_id() IS NOT NULL` — vacuous. Any authenticated
--         principal could seat themselves in any room by id and then read it through
--         messages_member, which delegates to is_room_member. The MSG-03 ethical wall had no
--         database backstop at all.
--   17.d  surveillance_hits and message_reviews were scoped to `app_role() = 'compliance'` with no
--         firm predicate: firm B's compliance officer read (and cleared) firm A's hits, including
--         matched_text, a verbatim excerpt of a message body they correctly could not read.
--   17.e  The MSG-02 scan ran inside the sender's transaction, where app.role is 'user', so every
--         INSERT into surveillance_hits was refused and swallowed. The compliance archive was
--         empty. A SECURITY DEFINER writer lets the scan record a hit without the sender's
--         transaction pretending to be compliance.
--   17.f  The hash chain covered prev_hash, room_id, seq, sender, sent_at, body and attachments
--         only. An MSG-06 IOI could be rewritten from {side:'buy',qty:10000,price:42.5} to
--         {side:'sell',qty:1,price:9999} and verifyChain still returned ok, as could the sending
--         firm. digest_version 2 covers structured, sender_firm_id and client_msg_id.
--   17.g  The chain was not anchored: re-hashing a suffix, rewriting a room from seq 1, or simply
--         deleting the last message all verified clean. rooms.last_seq / rooms.last_hash are
--         maintained by the trigger and refuse to go backwards.
--   17.h  alerts/engine.ts cannot see other owners' alerts under any context 0015 permits
--         (alerts_owner answers app_user_id(); alert_events' WITH CHECK answers app_firm_id()),
--         so NEWS-07 could not fan out at all. Two SECURITY DEFINER helpers give the engine a read
--         path and a writer without handing terminal_app a blanket bypass.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 17.a  REG-01: the retention floor, at the table
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2557 days = seven years (7 × 365 + 2 leap days). Back-fill before the constraint so an
-- already-lowered room is raised rather than blocking the migration.
UPDATE rooms SET retention_days = 2557 WHERE retention_days < 2557;
ALTER TABLE rooms ADD CONSTRAINT rooms_retention_floor CHECK (retention_days >= 2557);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 17.b  rooms: the creator always sees their own room
-- ─────────────────────────────────────────────────────────────────────────────────────────────
DROP POLICY rooms_member ON rooms;
CREATE POLICY rooms_member ON rooms
  USING (created_by = app_user_id()
         OR is_room_member(rooms.room_id, app_user_id())
         OR (app_role() = 'compliance' AND room_has_firm(rooms.room_id, app_firm_id())))
  WITH CHECK (created_by = app_user_id());

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 17.c  room_members: only a steward seats somebody
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- A policy on room_members cannot sub-select room_members (Postgres raises "infinite recursion
-- detected in policy"), so the test is a SECURITY DEFINER helper, as 0015 already does for
-- is_room_member. Two cases are permitted and no others:
--
--   1. the room has no seats yet and the actor is its creator taking the first one — this is
--      createRoom's own first INSERT, and it is the only way a room ever acquires a steward;
--   2. the actor holds an open 'owner' or 'supervisor' seat in that room — which is exactly what
--      `requireSteward` checks at the route layer, restated where it cannot be bypassed.
--
-- A member seating themselves is NOT one of them. `service.join` is reached through
-- POST /rooms/:roomId/members, which a steward calls on someone else's behalf; a self-join by row
-- insertion is the attack this replaces a vacuous WITH CHECK to stop.
CREATE FUNCTION can_seat_room_member(p_room_id bigint, p_actor bigint, p_user_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_actor IS NOT NULL AND (
    (p_user_id = p_actor
     AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = p_room_id)
     AND EXISTS (SELECT 1 FROM rooms r WHERE r.room_id = p_room_id AND r.created_by = p_actor))
    OR EXISTS (SELECT 1 FROM room_members m
                WHERE m.room_id = p_room_id AND m.user_id = p_actor
                  AND m.left_at IS NULL AND m.role IN ('owner','supervisor'))
  ) $$;
REVOKE ALL ON FUNCTION can_seat_room_member(bigint, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION can_seat_room_member(bigint, bigint, bigint) TO terminal_app;

DROP POLICY room_members_visible ON room_members;
CREATE POLICY room_members_visible ON room_members
  USING (user_id = app_user_id()
         OR is_room_member(room_members.room_id, app_user_id())
         OR (app_role() = 'compliance' AND room_has_firm(room_members.room_id, app_firm_id())))
  WITH CHECK (can_seat_room_member(room_members.room_id, app_user_id(), room_members.user_id));

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 17.d  Surveillance: compliance, of the room's own firms
-- ─────────────────────────────────────────────────────────────────────────────────────────────
DROP POLICY surveillance_hits_compliance ON surveillance_hits;
CREATE POLICY surveillance_hits_compliance ON surveillance_hits
  USING (app_role() = 'compliance'
         AND EXISTS (SELECT 1 FROM messages m
                      WHERE m.message_id = surveillance_hits.message_id
                        AND room_has_firm(m.room_id, app_firm_id())))
  WITH CHECK (app_role() = 'compliance'
              AND EXISTS (SELECT 1 FROM messages m
                           WHERE m.message_id = surveillance_hits.message_id
                             AND room_has_firm(m.room_id, app_firm_id())));
DROP POLICY message_reviews_compliance ON message_reviews;
CREATE POLICY message_reviews_compliance ON message_reviews
  USING (app_role() = 'compliance'
         AND EXISTS (SELECT 1 FROM messages m
                      WHERE m.message_id = message_reviews.message_id
                        AND room_has_firm(m.room_id, app_firm_id())))
  WITH CHECK (app_role() = 'compliance'
              AND EXISTS (SELECT 1 FROM messages m
                           WHERE m.message_id = message_reviews.message_id
                             AND room_has_firm(m.room_id, app_firm_id())));

-- The messages_member policy answers the reader's own membership, and the EXISTS above is
-- evaluated as the reader, so a compliance officer of a firm in the room can still not see the
-- message row itself unless membership says so. `room_has_firm` is SECURITY DEFINER precisely so
-- the *scoping* question is answerable without widening what the reader may select.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 17.e  MSG-02: a supervisory writer for the scan
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The scan runs on the sender's transaction (app.role 'user'), which is where the body is. It must
-- not be able to *read* the queue, so this is a writer and nothing else: it inserts one hit for a
-- message that exists, idempotently on (message_id, term_id), and returns nothing.
CREATE FUNCTION record_surveillance_hit(p_message_id bigint, p_term_id bigint,
                                        p_matched_text text, p_detected_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.message_id = p_message_id) THEN
    RAISE EXCEPTION 'no such message %', p_message_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM surveillance_lexicon l WHERE l.term_id = p_term_id) THEN
    RAISE EXCEPTION 'no such lexicon term %', p_term_id;
  END IF;
  INSERT INTO surveillance_hits (message_id, term_id, matched_text, detected_at, review_status)
  VALUES (p_message_id, p_term_id, left(p_matched_text, 200), p_detected_at, 'open')
  ON CONFLICT (message_id, term_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION record_surveillance_hit(bigint, bigint, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_surveillance_hit(bigint, bigint, text, timestamptz) TO terminal_app;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 17.f/g  The chain: a wider digest and an anchor
-- ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE messages ADD COLUMN digest_version smallint NOT NULL DEFAULT 2;
COMMENT ON COLUMN messages.digest_version IS
  'Which expression produced `hash`. 1 = the 0015 digest (prev_hash, room_id, seq, sender, sent_at, body, attachments); 2 = 1 plus structured, sender_firm_id and client_msg_id. verifyChain picks by version so archived rooms keep verifying.';
-- Rows written before this migration were hashed with version 1.
UPDATE messages SET digest_version = 1;
ALTER TABLE messages ALTER COLUMN digest_version SET DEFAULT 2;

-- The anchor. `last_seq` and `last_hash` are maintained by the chain trigger and may only move
-- forward, so deleting the tail of a room, re-hashing a suffix or rewriting a room from seq 1 all
-- leave the anchor disagreeing with what the table now holds.
ALTER TABLE rooms ADD COLUMN last_seq  bigint NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN last_hash bytea;
COMMENT ON COLUMN rooms.last_seq IS
  'Chain anchor (MSG-02): the highest seq ever written to this room. Monotonic — the chain trigger refuses a decrease, so a truncated or rewritten room is detectable by comparing it against the rows that remain.';
UPDATE rooms r
   SET last_seq  = coalesce(m.seq, 0),
       last_hash = m.hash
  FROM (SELECT DISTINCT ON (room_id) room_id, seq, hash
          FROM messages ORDER BY room_id, seq DESC) m
 WHERE m.room_id = r.room_id;

-- The trigger writes `rooms`, and `rooms` is under RLS with a WITH CHECK of
-- `created_by = app_user_id()` — which a sender who is not the creator does not satisfy. The
-- anchor update is therefore made by a SECURITY DEFINER owner function rather than inline.
CREATE FUNCTION anchor_room_chain(p_room_id bigint, p_seq bigint, p_hash bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE rooms SET last_seq = p_seq, last_hash = p_hash
   WHERE room_id = p_room_id AND p_seq > last_seq;
END $$;
REVOKE ALL ON FUNCTION anchor_room_chain(bigint, bigint, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION anchor_room_chain(bigint, bigint, bytea) TO terminal_app;

CREATE OR REPLACE FUNCTION messages_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev bytea; last_seq bigint; anchor_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('room:' || NEW.room_id::text));
  SELECT hash, seq INTO prev, last_seq FROM messages WHERE room_id = NEW.room_id ORDER BY seq DESC LIMIT 1;
  SELECT r.last_seq INTO anchor_seq FROM rooms r WHERE r.room_id = NEW.room_id;

  NEW.seq            := greatest(coalesce(last_seq, 0), coalesce(anchor_seq, 0)) + 1;
  NEW.prev_hash      := prev;
  NEW.digest_version := 2;
  NEW.hash           := digest(coalesce(prev, '\x'::bytea)
                          || convert_to(NEW.room_id::text || '|' || NEW.seq::text || '|' || NEW.sender_user_id::text || '|'
                                        || to_char(NEW.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
                                        || NEW.body || '|' || NEW.attachments::text || '|'
                                        || coalesce(NEW.structured::text, '') || '|'
                                        || NEW.sender_firm_id::text || '|'
                                        || NEW.client_msg_id::text, 'UTF8'),
                          'sha256');

  RETURN NEW;
END $$;

-- The anchor moves AFTER the row is durable, never in the BEFORE trigger.
--
-- `send()` inserts with `ON CONFLICT (room_id, client_msg_id) DO NOTHING`, and a BEFORE INSERT
-- trigger runs *before* the conflict is detected: the losing half of an idempotent retry would
-- advance `last_seq` for a row that is then discarded, and the room would read as one message
-- short of its own anchor for ever after. An AFTER INSERT trigger does not fire for a skipped
-- row, which is exactly the condition the anchor is trying to state.
CREATE FUNCTION messages_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM anchor_room_chain(NEW.room_id, NEW.seq, NEW.hash);
  RETURN NULL;
END $$;
CREATE TRIGGER messages_anchor_trg AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_anchor();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 17.h  NEWS-07: a read path and a writer the fan-out can actually use
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The engine evaluates every owner's alerts against one market event, so it cannot run under any
-- single owner's context. Rather than hand terminal_app a bypass on `alerts`, it gets two narrow
-- SECURITY DEFINER entry points: one that lists armed alerts of one kind, one that appends the
-- event row. Neither can read an alert's owner's other data, and neither can write anything but an
-- alert_events row that belongs to the alert it names.
CREATE FUNCTION armed_alerts(p_kind text, p_instrument_id bigint DEFAULT NULL)
RETURNS TABLE (alert_id bigint, owner_user_id bigint, firm_id bigint, kind text,
               instrument_id bigint, condition jsonb, delivery text[], one_shot boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.alert_id, a.owner_user_id, a.firm_id, a.kind, a.instrument_id,
         a.condition, a.delivery, a.one_shot
    FROM alerts a
   WHERE a.kind = p_kind AND a.status = 'armed'
     AND (p_instrument_id IS NULL OR a.instrument_id = p_instrument_id)
   ORDER BY a.alert_id $$;
REVOKE ALL ON FUNCTION armed_alerts(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION armed_alerts(text, bigint) TO terminal_app;

-- The claim and the event row, in one statement so a second fan-out cannot squeeze between them.
-- Returns NULL when the alert was not armed any more, which is what makes a `one_shot` alert fire
-- exactly once under concurrency.
CREATE FUNCTION fire_alert(p_alert_id bigint, p_fired_at timestamptz,
                           p_payload jsonb, p_delivered jsonb)
RETURNS TABLE (event_id bigint, fired_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_firm_id bigint;
BEGIN
  UPDATE alerts
     SET last_fired_at = p_fired_at,
         status = CASE WHEN one_shot THEN 'fired' ELSE status END
   WHERE alert_id = p_alert_id AND status = 'armed'
  RETURNING alerts.firm_id INTO v_firm_id;
  IF v_firm_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    INSERT INTO alert_events (alert_id, firm_id, fired_at, payload, delivered)
    VALUES (p_alert_id, v_firm_id, p_fired_at, p_payload, p_delivered)
    RETURNING alert_events.event_id, alert_events.fired_at;
END $$;
REVOKE ALL ON FUNCTION fire_alert(bigint, timestamptz, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fire_alert(bigint, timestamptz, jsonb, jsonb) TO terminal_app;

-- Reading back what an alert has already fired on, for the news/filing/calendar dedupe, needs the
-- same elevation for the same reason.
CREATE FUNCTION alert_fired_on(p_alert_id bigint, p_key text, p_value text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM alert_events e
                  WHERE e.alert_id = p_alert_id AND e.payload->>p_key = p_value) $$;
REVOKE ALL ON FUNCTION alert_fired_on(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_fired_on(bigint, text, text) TO terminal_app;

-- A saved search is read on behalf of the alert's owner and never on behalf of whoever named it.
CREATE FUNCTION saved_search_query(p_search_id bigint, p_owner_user_id bigint, p_kind text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.query FROM saved_searches s
   WHERE s.search_id = p_search_id AND s.owner_user_id = p_owner_user_id AND s.kind = p_kind $$;
REVOKE ALL ON FUNCTION saved_search_query(bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saved_search_query(bigint, bigint, text) TO terminal_app;
