#!/usr/bin/env bash
#
# scripts/deploy-probe.sh — can this Postgres host run our migrations at all?
#
# `docs/DEPLOYMENT.md` §2.3 and §7 step 0. Run this against a candidate free Postgres BEFORE any
# other deployment work: `drizzle/migrations/0015_roles_rls_worm.sql` runs `CREATE ROLE`, and a
# managed host gives you an owner role rather than a superuser. If `CREATEROLE` is missing the
# migration chain stops at 15 of 19 and nothing works, so this is ten minutes that can save a day.
#
# Shell and not tsx on purpose: it needs nothing but `psql`, and it runs before `npm install`.
#
#   ./scripts/deploy-probe.sh 'postgresql://user:pass@host/db?sslmode=require'
#
# The URL is a POSITIONAL ARGUMENT and is checked, deliberately. An earlier version of this probe
# lived in the documentation as a snippet reading `$CANDIDATE_URL`, and an unset variable makes psql
# fall back to its own defaults — local socket, database named after the user — so it reported
# `FATAL: database "<you>" does not exist` and tested nothing at all. A probe that silently probes
# the wrong server is worse than no probe.

set -uo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
  cat >&2 <<'USAGE'
usage: ./scripts/deploy-probe.sh <DATABASE_URL>

  Quote the URL — it contains characters your shell will otherwise eat:

    ./scripts/deploy-probe.sh 'postgresql://user:pass@host/dbname?sslmode=require'

  To probe your LOCAL postgres instead (note: a local superuser passes everything,
  so a local pass does NOT predict a managed host):

    ./scripts/deploy-probe.sh "postgresql:///postgres?host=/tmp&user=$USER"
USAGE
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "FAIL  psql is not on PATH. Install the postgresql client and re-run." >&2
  exit 2
fi

# One connection per probe, so a server that drops the session on a refused statement still lets the
# rest run and the report is complete rather than truncated at the first failure.
q() { psql "$URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1" 2>&1; }

fails=0
warns=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fails=$((fails + 1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; warns=$((warns + 1)); }

echo
echo "Probing $(printf '%s' "$URL" | sed -E 's#(//[^:]*):[^@]*@#\1:****@#')"
echo

# ── 0. reachable at all ────────────────────────────────────────────────────────────────────────
echo "connection"
if out=$(q 'SELECT 1') && [ "$out" = "1" ]; then
  pass "reachable"
else
  fail "cannot connect: $out"
  echo
  echo "Nothing else can be tested. Check the URL, the password, and whether the host needs"
  echo "?sslmode=require (most managed Postgres does)."
  exit 1
fi

# ── 1. version ─────────────────────────────────────────────────────────────────────────────────
echo
echo "server version (DATA_MODEL.md targets 14+)"
ver=$(q 'SHOW server_version_num')
vtext=$(q 'SHOW server_version')
if [ -n "$ver" ] && [ "$ver" -ge 140000 ] 2>/dev/null; then
  pass "$vtext"
else
  fail "$vtext — the migrations use declarative partitioning and gen_random_uuid()"
fi

# ── 2. the role we connect as ──────────────────────────────────────────────────────────────────
echo
echo "the role this URL connects as"
who=$(q 'SELECT current_user')
priv=$(q "SELECT rolsuper::text || ' ' || rolcreaterole::text FROM pg_roles WHERE rolname = current_user")
super=${priv%% *}
creater=${priv##* }
echo "        current_user = $who  (superuser=$super createrole=$creater)"
if [ "$super" = "true" ]; then
  warn "this role is a SUPERUSER, so every probe below passes trivially and tells you"
  echo "        nothing about a managed host. Fine for a local sanity check; if this is your"
  echo "        cloud candidate, it is unusually permissive — read §5 before you deploy."
fi

# ── 3. THE ONE THAT CAN REFUSE THE DEPLOYMENT ──────────────────────────────────────────────────
echo
echo "CREATE ROLE — migration 0015_roles_rls_worm.sql L6 and L63"
if out=$(q 'CREATE ROLE deploy_probe_role LOGIN'); then
  pass "can create a login role"
  q 'DROP ROLE deploy_probe_role' >/dev/null 2>&1 || warn "created deploy_probe_role but could not drop it — remove it by hand"
else
  fail "refused: $(printf '%s' "$out" | head -1)"
  echo "        0015 creates terminal_app and terminal_maint. Without CREATEROLE the chain stops"
  echo "        at 15 of 19. Either pick another host, or 0015 needs a single-role variant —"
  echo "        which is a change to a security migration and not a casual one."
fi

# ── 4. extensions ──────────────────────────────────────────────────────────────────────────────
echo
echo "extensions — migration 0001_extensions_enums.sql"
for ext in uuid-ossp btree_gist pg_trgm pgcrypto; do
  if q "CREATE EXTENSION IF NOT EXISTS \"$ext\"" >/dev/null 2>&1; then
    pass "$ext"
  else
    avail=$(q "SELECT count(*) FROM pg_available_extensions WHERE name = '$ext'")
    if [ "$avail" = "0" ]; then
      fail "$ext is not available on this host at all"
    else
      fail "$ext is available but this role may not create it"
    fi
  fi
done

# ── 5. RLS and SECURITY DEFINER ────────────────────────────────────────────────────────────────
echo
echo "row-level security and SECURITY DEFINER (0015, 0017, 0018)"
rls=$(q 'CREATE TABLE deploy_probe_t (id int, firm int);
         ALTER TABLE deploy_probe_t ENABLE ROW LEVEL SECURITY;
         CREATE POLICY p ON deploy_probe_t USING (true);
         CREATE FUNCTION deploy_probe_f() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER
           SET search_path = public AS $$ SELECT 1 $$;
         SELECT deploy_probe_f()')
if [ "$(printf '%s' "$rls" | tail -1)" = "1" ]; then
  pass "can enable RLS, write a policy, and own a SECURITY DEFINER function"
else
  fail "refused: $(printf '%s' "$rls" | head -1)"
  echo "        The messaging archive and the alert engine both depend on SECURITY DEFINER"
  echo "        helpers that bypass a non-FORCEd policy. This is not optional."
fi
q 'DROP FUNCTION IF EXISTS deploy_probe_f(); DROP TABLE IF EXISTS deploy_probe_t' >/dev/null 2>&1

# ── 6. partitioning ────────────────────────────────────────────────────────────────────────────
echo
echo "declarative partitioning (0016_partitions_initial.sql)"
part=$(q "CREATE TABLE deploy_probe_p (t timestamptz NOT NULL, v int) PARTITION BY RANGE (t);
          CREATE TABLE deploy_probe_p_x PARTITION OF deploy_probe_p
            FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
          SELECT count(*) FROM deploy_probe_p")
if [ "$(printf '%s' "$part" | tail -1)" = "0" ]; then
  pass "range partitions with attached children"
else
  fail "refused: $(printf '%s' "$part" | head -1)"
fi
q 'DROP TABLE IF EXISTS deploy_probe_p' >/dev/null 2>&1

# ── 7. room ────────────────────────────────────────────────────────────────────────────────────
echo
echo "storage headroom (the seeded universe is ~141 MB; ~45 MB if the seed is trimmed)"
echo "        This probe cannot read your plan's quota — check it in the host's console."
free=$(q "SELECT pg_size_pretty(pg_database_size(current_database()))")
echo "        this database currently holds $free"

# ── verdict ────────────────────────────────────────────────────────────────────────────────────
echo
if [ "$fails" -eq 0 ]; then
  printf '\033[32mALL PROBES PASSED\033[0m'
  [ "$warns" -gt 0 ] && printf ' (%d warning(s) above)' "$warns"
  echo
  echo "This host can run the migrations. Paste the output into the session and the deployment"
  echo "work in docs/DEPLOYMENT.md §7 can start."
  exit 0
fi

printf '\033[31m%d PROBE(S) FAILED\033[0m\n' "$fails"
echo "Do not start the deployment work. Send the output — a failure here changes the plan's shape."
exit 1
