-- 0020 — sign-in codes by email: the second factor the session model already had a gate for.
--
-- The gate exists since WP-07 (API.md §1.1 L57): when `users.mfa_required` is true a password login
-- yields a session with `mfa_verified = false` that may only call `/auth/*`, and every other route
-- answers `401 MFA_REQUIRED` until something upgrades it. Until now the only thing that could was
-- WebAuthn, and no WebAuthn UI exists — so an MFA user could not finish signing in through the
-- terminal at all. This is the second way through the same gate: a six-digit code sent to the
-- address on the account.
--
-- Four properties are the whole point of the table, and each is enforced here or at the one
-- statement that changes a row, never only in application memory:
--
--   * A code is STORED HASHED. `code_hash` is HMAC-SHA256 keyed with `SESSION_SECRET` over
--     `code_id || ':' || code` (`http/auth/emailCode.ts`), so a copy of this table without the
--     server's secret does not yield a live code, and two rows with the same six digits do not
--     share a hash. 32 bytes, checked.
--   * A code belongs to ONE SESSION — the password-verified session that asked for it. It cannot
--     upgrade a second login of the same user, and it can never mint a session of its own: an email
--     code is a second factor only, or email alone would become account access.
--   * A code is SINGLE-USE and DIES after five wrong guesses. Both are single conditional UPDATEs
--     (`consumed_at IS NULL`, `attempts < 5`) so two concurrent requests cannot both win.
--   * Asking for a new code SUPERSEDES the old one, so at most one code per session is live.
--
--   20.a  the table
--   20.b  privileges — INSERT comes from 0015's default privileges; UPDATE only on the three columns
--         a code's life actually changes, so the application cannot rewrite a hash or an expiry

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 20.a  The table
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE mfa_email_codes (
  code_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid        NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  user_id        bigint      NOT NULL REFERENCES users (user_id),
  code_hash      bytea       NOT NULL CHECK (octet_length(code_hash) = 32),
  -- The address the code went to AT SEND TIME. An audit fact, and the answer to "where did my code
  -- go?" if the account's address is changed between sending and signing in.
  sent_to        text        NOT NULL,
  -- Both written by the application from its injected Clock, so a test can expire a code by
  -- advancing virtual time instead of sleeping ten minutes. The defaults are a fallback only.
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  -- `5` is `MAX_ATTEMPTS` in http/auth/emailCode.ts, stated twice ON PURPOSE: the conditional UPDATE
  -- there is the enforcement, and this is the ceiling that holds even if that statement is ever
  -- written wrong. `emailCode.test.ts` asserts the two agree.
  attempts       integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at    timestamptz,
  superseded_at  timestamptz,
  CHECK (expires_at > created_at),
  -- A code is used, or replaced, never both: the two terminal states are exclusive.
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);

COMMENT ON TABLE mfa_email_codes IS
  'Email sign-in codes (second factor only). Hashed, single-use, session-bound, 5 attempts. 0020.';

-- The one lookup every verify makes: this session's live code, newest first.
CREATE INDEX mfa_email_codes_live_idx
    ON mfa_email_codes (session_id, created_at DESC)
 WHERE consumed_at IS NULL AND superseded_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 20.b  Privileges
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- `terminal_app` already gets SELECT and INSERT on every new table from 0015 L13's default
-- privileges. UPDATE is granted table by table in this schema (0015 L17), and here it is granted
-- column by column: a code's attempts, its consumption and its supersession are the only things
-- that ever change. No DELETE — an expired code is dead by its timestamps, and the `ON DELETE
-- CASCADE` above clears a session's codes when retention removes the session.
--
-- The local database owner is a superuser and bypasses every grant, so a test run as the owner
-- proves nothing about this block; `emailCode` integration tests exercise it under
-- `SET LOCAL ROLE terminal_app`, the pattern `bitemporal-write.test.ts` L870 established.

GRANT UPDATE (attempts, consumed_at, superseded_at) ON mfa_email_codes TO terminal_app;
