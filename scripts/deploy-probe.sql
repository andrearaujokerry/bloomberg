-- scripts/deploy-probe.sql — the deployment preflight, for a web SQL console.
--
-- `scripts/deploy-probe.sh` is the same seven checks over psql. Use THIS file when port 5432 is
-- blocked from your machine — a corporate, campus or café network commonly filters database ports,
-- and a provider's web console runs over 443, so it gets through when psql cannot.
--
-- Paste the whole file into Neon's SQL Editor (or Supabase's) and run it. It prints one row per
-- check. Paste the result back into the session.
--
-- SAFE TO RUN ON A DATABASE YOU CARE ABOUT, and written to be: every object it makes is prefixed
-- `_deploy_probe` and dropped by step 9, every probe is wrapped in its own exception handler so a
-- refusal is RECORDED rather than aborting the script, and nothing reads or writes application data.
-- It is still a probe for an EMPTY database — run it before the migrations, not after.
--
-- docs/DEPLOYMENT.md §2.3.

-- 1. The results table. Real, not temporary: a web console may put each statement in its own
--    session, and a temp table would vanish between them.
DROP TABLE IF EXISTS _deploy_probe_results;
CREATE TABLE _deploy_probe_results (
  seq     int  PRIMARY KEY,
  check_  text NOT NULL,
  verdict text NOT NULL,
  detail  text
);

-- 2. Every probe, each in its own exception handler.
DO $probe$
DECLARE
  v_ver    int;
  v_vtext  text;
  v_super  bool;
  v_create bool;
  v_ext    text;
  v_ok     int;
BEGIN
  -- ── connection and version ──────────────────────────────────────────────────────────────────
  SELECT current_setting('server_version_num')::int, version() INTO v_ver, v_vtext;
  INSERT INTO _deploy_probe_results VALUES (
    1, 'server version >= 14',
    CASE WHEN v_ver >= 140000 THEN 'PASS' ELSE 'FAIL' END,
    v_vtext
  );

  -- ── the role this console connects as ───────────────────────────────────────────────────────
  SELECT rolsuper, rolcreaterole INTO v_super, v_create
    FROM pg_roles WHERE rolname = current_user;
  INSERT INTO _deploy_probe_results VALUES (
    2, 'connecting role',
    CASE WHEN v_super THEN 'WARN' ELSE 'INFO' END,
    format('%s (superuser=%s createrole=%s)%s', current_user, v_super, v_create,
           CASE WHEN v_super THEN ' — a superuser passes everything below trivially' ELSE '' END)
  );

  -- ── THE ONE THAT CAN REFUSE THE DEPLOYMENT (migration 0015 L6, L63) ─────────────────────────
  BEGIN
    EXECUTE 'CREATE ROLE _deploy_probe_role LOGIN';
    EXECUTE 'DROP ROLE _deploy_probe_role';
    INSERT INTO _deploy_probe_results VALUES (3, 'CREATE ROLE (migration 0015)', 'PASS',
      'can create and drop a login role');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _deploy_probe_results VALUES (3, 'CREATE ROLE (migration 0015)', 'FAIL',
      SQLERRM || ' — 0015 creates terminal_app and terminal_maint; without this the chain stops at 15 of 19');
  END;

  -- ── the four extensions (migration 0001) ────────────────────────────────────────────────────
  FOREACH v_ext IN ARRAY ARRAY['uuid-ossp', 'btree_gist', 'pg_trgm', 'pgcrypto'] LOOP
    BEGIN
      EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I', v_ext);
      INSERT INTO _deploy_probe_results VALUES (
        10 + array_position(ARRAY['uuid-ossp','btree_gist','pg_trgm','pgcrypto'], v_ext),
        'extension ' || v_ext, 'PASS', NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO _deploy_probe_results VALUES (
        10 + array_position(ARRAY['uuid-ossp','btree_gist','pg_trgm','pgcrypto'], v_ext),
        'extension ' || v_ext, 'FAIL',
        SQLERRM || CASE WHEN EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = v_ext)
                        THEN ' (available on the host, but this role may not create it)'
                        ELSE ' (NOT available on this host at all)' END);
    END;
  END LOOP;

  -- ── RLS plus a SECURITY DEFINER function (migrations 0015, 0017, 0018) ──────────────────────
  BEGIN
    EXECUTE 'CREATE TABLE _deploy_probe_t (id int, firm int)';
    EXECUTE 'ALTER TABLE _deploy_probe_t ENABLE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY p ON _deploy_probe_t USING (true)';
    EXECUTE 'CREATE FUNCTION _deploy_probe_f() RETURNS int LANGUAGE sql STABLE '
         || 'SECURITY DEFINER SET search_path = public AS ''SELECT 1''';
    EXECUTE 'SELECT _deploy_probe_f()' INTO v_ok;
    INSERT INTO _deploy_probe_results VALUES (20, 'RLS + SECURITY DEFINER',
      CASE WHEN v_ok = 1 THEN 'PASS' ELSE 'FAIL' END,
      'the messaging archive and the alert engine both depend on these');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _deploy_probe_results VALUES (20, 'RLS + SECURITY DEFINER', 'FAIL', SQLERRM);
  END;

  -- ── declarative partitioning (migration 0016) ───────────────────────────────────────────────
  BEGIN
    EXECUTE 'CREATE TABLE _deploy_probe_p (t timestamptz NOT NULL, v int) PARTITION BY RANGE (t)';
    EXECUTE 'CREATE TABLE _deploy_probe_p_x PARTITION OF _deploy_probe_p '
         || 'FOR VALUES FROM (''2026-01-01'') TO (''2027-01-01'')';
    EXECUTE 'SELECT count(*)::int FROM _deploy_probe_p' INTO v_ok;
    INSERT INTO _deploy_probe_results VALUES (21, 'declarative partitioning', 'PASS',
      'range partitions with attached children');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _deploy_probe_results VALUES (21, 'declarative partitioning', 'FAIL', SQLERRM);
  END;

  -- ── room ────────────────────────────────────────────────────────────────────────────────────
  INSERT INTO _deploy_probe_results VALUES (30, 'current database size', 'INFO',
    pg_size_pretty(pg_database_size(current_database()))
    || ' now; the seeded universe is ~141 MB, or ~45 MB trimmed');
END
$probe$;

-- 3. The report. This is what to paste back.
SELECT seq, check_ AS check, verdict, detail
  FROM _deploy_probe_results
 ORDER BY seq;

-- 4. The verdict in one line.
SELECT CASE
         WHEN count(*) FILTER (WHERE verdict = 'FAIL') = 0
           THEN 'ALL PROBES PASSED — this host can run the migrations'
         ELSE count(*) FILTER (WHERE verdict = 'FAIL')::text
              || ' PROBE(S) FAILED — do not start the deployment work'
       END AS verdict
  FROM _deploy_probe_results;

-- 5. Clean up. Leaves the four extensions in place, which the migrations want anyway.
DROP FUNCTION IF EXISTS _deploy_probe_f();
DROP TABLE IF EXISTS _deploy_probe_t;
DROP TABLE IF EXISTS _deploy_probe_p;
DROP TABLE IF EXISTS _deploy_probe_results;
