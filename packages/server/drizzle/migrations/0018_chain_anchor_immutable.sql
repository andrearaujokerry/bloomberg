-- 0018 — the MSG-02 chain anchor is made immutable to the role the server connects as.
--
-- 0017 §17.g added `rooms.last_seq` / `rooms.last_hash` and called them "the one statement about
-- the room that rewriting `messages` does not restate". They were not. 15.b grants table-level
-- UPDATE on `rooms` to terminal_app and `rooms_member`'s WITH CHECK is `created_by =
-- app_user_id()`, so the room's own creator — under the ordinary application role, with no owner
-- rights and no DDL — could simply restate it:
--
--   SET LOCAL ROLE terminal_app;
--   SELECT set_config('app.user_id', '<creator>', true), …;
--   UPDATE rooms SET last_seq = 0, last_hash = NULL WHERE room_id = <room>;   -- succeeded
--   UPDATE rooms SET last_seq = 99, last_hash = digest('forged','sha256') …;  -- succeeded
--
-- With that the suffix re-hash and the rewrite-from-seq-1 of 0017 §17.g both verify clean again:
-- rewrite `messages`, re-point the anchor at the forged head, and `verifyChain` agrees. An anchor
-- the attacker can move is not an anchor, so the whole of §17.g rested on a grant nobody had
-- narrowed.
--
-- Two layers, the same pair 15.d uses for the WORM tables:
--
--   18.a  terminal_app loses table-level UPDATE on `rooms` and gets it back column by column, on
--         every column except the two anchor ones. `anchor_room_chain` (SECURITY DEFINER, owned by
--         the migration owner) stays the only way the anchor moves at all.
--   18.b  a BEFORE UPDATE trigger that refuses a *decrease* of `last_seq`, and refuses a change of
--         `last_hash` while `last_seq` stands still — defence in depth against the owner role,
--         which column privileges do not constrain. Both rules are needed: without the first a
--         room can be truncated and re-anchored, without the second a room of N messages can be
--         rewritten into a different N messages and re-anchored at the same seq.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 18.a  Column privileges: the application may write a room, never its anchor
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The list is every column of `rooms` except `last_seq`, `last_hash` and the identity `room_id`
-- (which is GENERATED ALWAYS and cannot be updated in any case). It is written out rather than
-- generated, because a column added by a later migration should have to be named here on purpose:
-- the failure mode of forgetting is "permission denied for table rooms" on a write path, which is
-- loud, and the failure mode of an automatic grant is a second anchor column nobody protected.
REVOKE UPDATE ON rooms FROM terminal_app;
GRANT UPDATE (kind, name, firm_id, scope, created_by, created_at, retention_days, disclaimer,
              wall_tag, policy)
  ON rooms TO terminal_app;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 18.b  The anchor is monotonic for every role, including the owner
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- `anchor_room_chain` only ever advances (`WHERE … p_seq > last_seq`), so the ordinary write path
-- satisfies both rules and never sees this trigger. Everything else does.
--
-- A migration that legitimately restates an anchor — re-hashing an archive under a later
-- `digest_version`, as 0017 did for version 1 → 2 — is the owner disabling this trigger for the
-- duration, exactly as a WORM correction disables `messages_worm`. That is deliberately a
-- conspicuous act in a migration file rather than something a stray UPDATE can do.
CREATE FUNCTION rooms_anchor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_seq < OLD.last_seq THEN
    RAISE EXCEPTION 'room % chain anchor may not move backwards (% → %)',
      OLD.room_id, OLD.last_seq, NEW.last_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.last_seq = OLD.last_seq AND NEW.last_hash IS DISTINCT FROM OLD.last_hash THEN
    RAISE EXCEPTION 'room % chain anchor may not be re-pointed at seq %',
      OLD.room_id, OLD.last_seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_anchor_guard_trg BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION rooms_anchor_guard();

COMMENT ON COLUMN rooms.last_seq IS
  'Chain anchor (MSG-02): the highest seq ever written to this room. Monotonic — 0018 refuses a decrease at the table and withholds UPDATE on this column from terminal_app, so only anchor_room_chain moves it. A truncated or rewritten room is detectable by comparing it against the rows that remain.';
COMMENT ON COLUMN rooms.last_hash IS
  'Chain anchor (MSG-02): the hash of the message at `last_seq`. Not writable by terminal_app (0018 §18.a) and not re-pointable at a seq the room already holds (§18.b), so a consistently re-hashed chain no longer agrees with it.';
