-- 0019 — `data_exceptions` becomes tenant-scoped, because PORT-07 was defeated by a side channel.
--
-- REF-10's exception queue was built for *reference* data — a CIK a SEC submission could not be
-- resolved to, a source conflict on a corporate action — and none of that belongs to a customer
-- firm. WP-10's portfolio import then wrote into the same table: `portfolio/service.ts`
-- #raiseUnresolvedException files one `unresolved_identifier` row per uploaded identifier the
-- master does not know, and that row carries, in `candidates`, the raw identifier out of the
-- victim's position file (often a proprietary internal code), the `portfolioId`, the `asOfDate`
-- the book is stated at, and in `reported_by` the id of the user who uploaded it.
--
-- `data_exceptions` had no `firm_id`, `relrowsecurity = false` and no policy, and
-- `GET /admin/exceptions` (roles `admin`, `dataops`) filtered on status, kind and assignee but
-- never on firm. `admin` is an ordinary *customer* firm admin — `users.firm_id` plus
-- `users.role` — not an internal operator, so an admin of an unrelated firm received HTTP 200
-- with another firm's uploaded identifier, portfolio id, as-of date and uploader in the body.
-- That is precisely the confirmation the 404-not-403 rule of PORT-07 exists to deny: it proves
-- the portfolio id is real, says when its book is dated and names one of its holdings.
--
--   19.a  `firm_id` on `data_exceptions`, NULL for the genuinely firm-less reference-data rows.
--   19.b  ENABLE + FORCE RLS with the policy migration 0015 §15.f gives portfolios/positions/
--         lots/portfolio_imports, widened by one branch: a row with no firm is reference data and
--         stays visible to every operator who may read the queue at all.
--
-- The application also carries the predicate in its own SQL (`http/routes/admin.ts`,
-- `portfolio/service.ts`), for the reason 15.f's own comment gives: the local database owner is a
-- superuser and bypasses RLS, so a test that passed only under the policy would prove nothing
-- about the code.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 19.a  The column
-- ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE data_exceptions
  ADD COLUMN firm_id bigint REFERENCES firms(firm_id);

COMMENT ON COLUMN data_exceptions.firm_id IS
  'Owning firm for an exception raised over tenant data (PORT-01 portfolio imports); NULL for reference-data exceptions, which belong to no customer firm.';

-- The queue is read as "everything open, oldest SLA first" per firm, so the firm leads the index.
CREATE INDEX data_exceptions_firm_idx ON data_exceptions (firm_id, status, sla_due_at NULLS LAST);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 19.b  Tenant isolation (PORT-07, SEC-05)
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- FORCE so the policy binds the table owner too. A connection with no firm context (every ingest
-- job) still writes and reads the `firm_id IS NULL` reference-data rows it owns, and sees no
-- tenant row at all.
ALTER TABLE data_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_exceptions FORCE ROW LEVEL SECURITY;

CREATE POLICY data_exceptions_tenant ON data_exceptions
  USING      (firm_id IS NULL OR firm_id = app_firm_id())
  WITH CHECK (firm_id IS NULL OR firm_id = app_firm_id());
