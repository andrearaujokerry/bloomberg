# DEPLOYMENT — putting this terminal on a public URL for nothing

A plan, the measurements it rests on, and a division of labour. Parts of it are done; §7 says which,
and §7.1 is the step-by-step setup on the hosts chosen — Render and Neon.

Read §2 first. Four of the six constraints in it are already satisfied by the build; two of them
decide the whole architecture, and one of them (`CREATE ROLE`, §2.3) can refuse the deployment
outright on the wrong host, so it is the first thing to test and it costs ten minutes.

**One thing up front, because it is the only item in this document that is not optional.** The seeded
password is `correct horse battery staple`, all seven accounts share it, and `docs/API.md` §12.1 calls
it DEV ONLY. Deploying as-is publishes authenticated access to anyone who reads this repository.
§5 is not advice.

---

## 1. The shape of it

```
                    ┌─────────────────────────────────────────┐
  browser  ───────► │  ONE free web service (persistent Node) │
   (https)          │                                          │
                    │  Fastify :8080                           │
                    │   ├── /api/v1/*      the plant            │
                    │   ├── /ws            the socket           │
                    │   └── /*             packages/web/dist   │ ◄── new, §4.2
                    └───────────────┬──────────────────────────┘
                                    │ TLS, pooled
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │  free managed Postgres 14+               │
                    │  4 contrib extensions, ~141 MB seeded    │
                    │  (~45 MB if §4.4 is taken)               │
                    └─────────────────────────────────────────┘
```

**One service, one origin.** That is not a preference, it is forced — see §2.1.

---

## 2. What has to be true, measured against the tree

### 2.1 The web app and the API must share an origin — FORCES THE ARCHITECTURE

`packages/web/vite.config.ts` L4-5 says the client is built on `RestClient({ baseUrl:
window.location.origin })`, and the WebSocket client resolves the same way. Nothing in
`packages/web/src` reads a `VITE_*` variable — there is no API base URL to configure, by design.

Independently, `packages/server/src/http/auth/session.ts` L251-254 sets the session cookie
`httpOnly`, `secure`, **`sameSite: 'strict'`**. A cookie set strict is not sent on a cross-site
request at all.

So splitting the SPA onto a static host (Cloudflare Pages, Netlify) and the API onto a Node host
needs *three* changes — a configurable base URL, CORS, and relaxing `sameSite` to `lax` or `none` —
and the third weakens a real defence to buy nothing. **Rejected.** Fastify serves the SPA (§4.2).

### 2.2 The process must be persistent, not serverless

The WebSocket gateway holds sessions open, and `plant/` and the hotset are in-memory. Edge and
lambda runtimes cannot host this. The host must run a long-lived Node 22.19+ process
(`package.json` `engines`) and must proxy WebSocket upgrades.

### 2.3 Four Postgres extensions, and two database ROLES — TEST THIS FIRST

`drizzle/migrations/0001_extensions_enums.sql`:

```
uuid-ossp    btree_gist    pg_trgm    pgcrypto
```

All four are standard contrib and present on every managed Postgres I know of. That half is fine.

**The half that can refuse you** is `0015_roles_rls_worm.sql` L6 and L63:

```sql
CREATE ROLE terminal_app LOGIN;
CREATE ROLE terminal_maint LOGIN;
```

A managed Postgres gives you an owner role, not a superuser. If that role lacks `CREATEROLE`, this
migration throws, the chain stops at 15 of 19, and nothing works. The migration also installs
row-level security plus `SECURITY DEFINER` helpers that deliberately bypass non-`FORCE`d policies
(0015 L160-165, 0017, 0018) — those are owned by whoever runs the migration, so they need that role
to own the tables too, which it will.

**The ten-minute test, before any other work** (§7, step 0) is `scripts/deploy-probe.sh`. Put the
URL in `.env.deploy` and run it with no arguments:

```bash
echo 'DEPLOY_DATABASE_URL=postgresql://user:pass@host/db?sslmode=require' > .env.deploy
./scripts/deploy-probe.sh
```

**Use the file, not an argument.** A connection string ends in `?sslmode=require`, and in zsh `?` is
a glob: an unquoted URL makes the SHELL fail with `no matches found` before the script is executed at
all, so its own "quote this" warning never prints. An unquoted `&` between query parameters is worse
— zsh backgrounds the command and silently truncates the URL, which could probe a different database
than the one you meant. The file also keeps the password out of your shell history. `.env.deploy` is
gitignored. An argument still works if single-quoted, and the script prints which source it used.

It checks the version, the four extensions, `CREATE ROLE`, RLS plus a `SECURITY DEFINER` function,
and declarative partitioning; it prints the role's `superuser`/`createrole` flags; and it exits
non-zero if anything fails. **Quote the URL** — it contains characters the shell will otherwise eat —
and pass it as an argument, which the script requires rather than reading from the environment. The
first version of this probe lived here as a snippet reading `$CANDIDATE_URL`, and an unset variable
makes `psql` fall back to the local socket and a database named after the user: it reported
`FATAL: database "<you>" does not exist` and tested nothing. A probe that silently probes the wrong
server is worse than no probe.

Verified both ways before being written down: against a local superuser it passes everything (with a
warning that a superuser pass predicts nothing about a managed host), and against a deliberately
`NOCREATEROLE` role it fails exactly one probe — `permission denied to create role` — and exits 1.

**If port 5432 is blocked from your machine, use `scripts/deploy-probe.sql` instead.** A corporate,
campus or café network commonly filters database ports, and a provider's web SQL console runs over
443, so it gets through when `psql` cannot. Paste that file into Neon's or Supabase's SQL Editor; it
runs the same seven checks, wraps each one in its own exception handler so a refusal is recorded
rather than aborting the script, prefixes every object it creates with `_deploy_probe`, and drops
them at the end. Verified against a scratch database as both a superuser and a `NOCREATEROLE` role.

A blocked 5432 **does not block the deployment** — the Node host connects to Postgres from the cloud,
not from your laptop. What it blocks is local admin: migrating, seeding and `create-user`. §7.1 says
how to run those from another network, and §7 item 8 is a GitHub job that runs them from GitHub.

If `CREATE ROLE` is refused, either the host is wrong or 0015 needs a `DEPLOY_SINGLE_ROLE` variant,
which is a schema change to a security migration and should not be done casually.

### 2.4 ~141 MB of data, and the free tiers are ~500 MB

Measured on `bloomberg_seed_test` (41,455 instruments):

| Table | Size |
| --- | --- |
| `identifiers` | 31 MB |
| `instruments` | 22 MB |
| `md_lines` | 16 MB |
| `issuers` | 16 MB |
| `xbrl_facts` | 12 MB |
| `issues` | 11 MB |
| everything else | ~33 MB |
| **total** | **141 MB** |

It fits a 500 MB tier with little headroom, and the top four rows — **85 MB of the 141** — are the
full Cboe symbol book, which a demo does not need. §4.4 is the optional trim.

### 2.3b STEP 0 RESULT, and the thing it found — THE DATABASE VERSION

Run against a free Neon project on 2026-10-06, through the web console (`scripts/deploy-probe.sql`,
because 5432 is blocked from the development machine — §2.3):

| # | Check | Verdict |
| --- | --- | --- |
| 1 | server version ≥ 14 | PASS — **PostgreSQL 18.6** |
| 2 | connecting role | `neondb_owner` — **superuser=f, createrole=t** |
| 3 | `CREATE ROLE` (migration 0015) | PASS |
| 11-14 | `uuid-ossp`, `btree_gist`, `pg_trgm`, `pgcrypto` | PASS |
| 20 | RLS + `SECURITY DEFINER` | PASS |
| 21 | declarative partitioning | PASS |

**All ten passed, and the passes are meaningful** — row 2 is the reason. `neondb_owner` is *not* a
superuser and *does* hold `CREATEROLE`, which is exactly the combination §2.3 was worried about. The
host can run the migrations.

**But Neon is Postgres 18.6, and this build is a Postgres 14 build.** `docs/DATA_MODEL.md` opens with
"final Postgres 14 data model" and records that every migration was "verified in order against a
scratch Postgres 14.17 database"; `docs/ARCHITECTURE.md` says Postgres 14 twice; the development
machine runs 14.17; and all 6,214 tests have only ever run against 14. Deploying to 18 would put the
schema on a version it has never touched, four majors ahead.

#### The obvious fix is the wrong one

Pinning the Neon project to Postgres 14 would match what is tested — and **Postgres 14 reaches end of
life in November 2026, which is about four weeks from this line.** Deploying onto a major version that
stops receiving security fixes within the month is not a deployment, it is a migration deferred at
interest. So the version move is not optional and the deployment did not create it; it surfaced it.

#### What the probe already tells us, and what it does not

It is genuine evidence, and it covers the surface most likely to break: all four extensions exist on
18.6, `CREATE ROLE` works, RLS with a `SECURITY DEFINER` function that bypasses a non-`FORCE`d policy
works, and declarative range partitioning with attached children works. One known hazard is already
handled in our own SQL rather than by luck — Postgres 15 removed `PUBLIC`'s implicit `CREATE` on
schema `public`, and `0015_roles_rls_worm.sql` L10 and L67 grant schema privileges explicitly
(`USAGE` to `terminal_app`, `USAGE, CREATE` to `terminal_maint`).

It does **not** tell us that the 19 migrations apply cleanly in order, or that 6,214 tests pass. Those
are the only two things that would, and neither has been run on 18.

#### STEP 1 AND 2 RESULT: all 19 migrations apply on 18.6, and the schema is identical

Run on 2026-10-06. `postgresql@18` installed beside 14 as a keg-only formula — 14's binaries stay
first on `PATH`, so nothing about the existing setup changed — and started on **port 5433**, manually
rather than through `brew services`, which would have fought for 5432:

```bash
brew install postgresql@18
LC_ALL="en_US.UTF-8" /opt/homebrew/opt/postgresql@18/bin/pg_ctl \
  -D /opt/homebrew/var/postgresql@18 -o "-p 5433" -l /tmp/pg18.log start
```

`LC_ALL` is required and is not optional: without it 18 dies at startup with
`FATAL: postmaster became multithreaded during startup`. It is a macOS-local quirk, not a finding
about this schema, and brew's own caveats mention it.

**All 19 migrations applied, exit 0, 19 applied / 0 already applied.** Then the schemas were compared
against a migrations-only Postgres 14 database (`bloomberg_pg14_cmp`, created for this rather than
using `bloomberg_test`, which must stay pristine):

| | PG 14.17 | PG 18.6 |
| --- | --- | --- |
| tables / partitioned / indexes / views | 148 / 6 / 383 / 6 | **same** |
| check / FK / PK / unique / exclusion constraints | 154 / 140 / 154 / 20 / 21 | **same** |
| our functions (not extension-owned) | 23 | **same** |
| RLS policies / enums | 20 / 11 | **same** |

Three raw counts did differ, and all three are the catalogue changing rather than the schema:

- **`pg_constraint` 489 → 1666.** Every type matches exactly; the whole difference is 1,177 rows of
  `contype='n'`, because **Postgres 17+ catalogues NOT NULL constraints** and 14 did not.
- **Functions 279 → 313.** Extension-owned only (256 → 290); ours is 23 in both.
- **Visible triggers 45 → 53.** The same five `access_log_worm` / `usage_events_worm` triggers exist
  in both — a parent plus four partition clones. **Postgres 15 flipped `tgisinternal` for clones**
  from `t` to `f`, so they stop being hidden. Verified functionally rather than by counting: an
  `UPDATE` and a `DELETE` on `access_log` are refused on BOTH versions with the identical message,
  `table access_log_m2026_10 is append-only (WORM)` — naming the partition, which is the clone
  trigger firing.

A full `pg_dump --schema-only` of both, taken with the **same** 18.6 binary so the tool cannot
introduce differences, left 252 diff lines after normalising the NOT NULL spelling. Every one is
cosmetic: `pg_dump`'s own `\restrict` nonce, one comment block about not creating schema `public`,
and the six bitemporal views, where a 14 server deparses `identifiers.version_id` and an 18 server
deparses `version_id`. Those six were then compared by what they return instead of how they are
spelled — **100 columns, identical names, order and types.**

**Conclusion: this schema is Postgres 18 clean.** Step 3 is what remains, and it is smaller than
estimated: `vitest.config.ts` L16-24 already reads `DATABASE_URL_TEST` and `DATABASE_URL_SEED_TEST`
from the environment with 5432 defaults, so pointing the whole suite at 18 needs **no code change** —
only those two variables set to 5433.

Note for whoever picks this up: PG 18 was started by hand and will not survive a reboot. Restart it
with the `pg_ctl` line above; stop it with the same command and `stop`.

#### The sequence this implies

`postgresql@18` is installable locally (`brew search postgresql@` offers 12 through 18), so the move
can be tested exactly rather than hoped at:

1. Install Postgres 18 beside 14 — different port, both running, nothing destroyed.
2. Apply all 19 migrations to an empty 18 database and read the failures.
3. Point the vitest projects at 18 and run the full suite twice, plus the e2e suite.
4. Fix what breaks; amend `DATA_MODEL.md` §20 and `ARCHITECTURE.md` where they name the version.
5. Only then deploy.

**That is its own work package, not a step in this plan**, and it is listed in §7 as item 0 because
nothing else should start before it. If it turns out to be a no-op — plausible, given what the probe
found — it is a cheap no-op with a test run behind it instead of an assumption.

#### And create the app database `C`-collated

Running the suite on a fresh 18 cluster found that every committed golden was captured under
`datcollate = C` and nothing said so (`BUILD_STATUS.md`, finding 1). The orderings whose stability is
load-bearing now pin `COLLATE "C"`, and startup warns on a mismatch — but the cleanest deployment
matches the captures exactly, and Neon's default database is very likely `en_US.UTF-8`:

```sql
CREATE DATABASE terminal LOCALE 'C' TEMPLATE template0;
```

`CREATE DATABASE` cannot run inside a transaction, so a web console that wraps statements may refuse
it; `scripts/deploy-probe.sh` attempts it for real and `deploy-probe.sql` reports whether the role has
`CREATEDB`. If neither works, create the database from the host's console and accept the startup
warning — the code no longer depends on it.

### 2.4b Pooled or direct connection — it matters in exactly two places

Managed hosts hand out two connection strings: a **direct** one and a **pooled** one through
PgBouncer in transaction mode. Transaction-mode pooling returns the connection to the pool at every
`COMMIT`, which breaks anything session-scoped. Checked against this tree:

| Feature | Used here? | Pooling-safe? |
| --- | --- | --- |
| `LISTEN` / `NOTIFY` | no | — |
| Prepared statements, cursors | no | — |
| `set_config('app.user_id', …, true)` — the RLS tenant | **yes**, everywhere | **Yes.** The third argument is `true`, which is transaction-scoped by design, so it lives exactly as long as the transaction that needs it. |
| `pg_try_advisory_lock` — the ingest leader | yes, in `ingest/lock.ts` | **No**, and that file says why: it takes the session-scoped lock deliberately, because leadership has to outlive thousands of transactions. |

So:

- **Migrations and the seed: the DIRECT string.** DDL, `CREATE ROLE`, `CREATE EXTENSION`.
- **The app at runtime: pooled is fine**, because the RLS mechanism is transaction-scoped. Use it —
  a free tier's connection ceiling is low.
- **The probe: the DIRECT string**, since it tests DDL.
- **If startup step 8 is ever armed** (§3 says not to), its connection must be unpooled or the leader
  lock is meaningless. Deferred today, so it does not bite — but it is the kind of thing that bites
  silently a year later, which is why it is written down here.

### 2.5 The database is written at runtime

Sessions, `access_log` and `usage_events` are all written while serving. A read-only replica or a
static dump will not do. An auto-suspending free tier (Neon) is fine — it wakes on connect.

### 2.6 Replay mode needs its fixtures, and they are already in git

`PROVIDER_MODE` defaults to `replay`, `REPLAY_DIR` to `../../fixtures/providers` — **19 MB,
committed**. A replay deployment makes no outbound calls at all: no API keys, no rate limits, no
provider can take the site down. For a free public demo this is the right mode, and it is the
default.

---

## 3. What the deployed site will and will not do

Say this on the page (§4.5). It is the same rule the rest of the build follows: a number is worth
what the viewer knows about it.

**Will:** restore the four-panel workspace, run all 38 functions over the seeded universe, resolve
and autocomplete 41,455 instruments, draw charts, flash a cell whose number moved, export CSV equal
to the screen, cite every value on screen, and serve the WebSocket.

**Will not:** show live or moving prices. Startup step 8 — the ingest scheduler — is deliberately
deferred (`startup.ts#DEFERRED_STARTUP_STEPS`), so nothing refreshes. `/health` already answers
`degraded` with `scheduler: false`, honestly. The site is a **frozen snapshot as of the seed's
capture date**, and it should say so where a visitor will see it.

Turning the scheduler on in a free deployment is a bad trade and not part of this plan: it needs the
`quote_ticks` two-writer decision made first (`BUILD_STATUS.md`), it would make outbound calls from a
shared host IP to SEC and Cboe under their rate limits, and it grows the database past the free tier
within days.

---

### 3.1 A frozen snapshot with a moving clock empties itself — FOUND 2026-10-06

The seeded bars end on 2026-09-15. Every relative window — `HP 1M`, `GP 1Y`, `GIP 5D` — ends on the
**wall clock**. So the overlap between "what the screen asks for" and "what the database holds" shrinks
by a day every day: `HP 1M` showed fifteen sessions when the e2e spec was written and **six** on
2026-10-06, which is how this was found (`BUILD_STATUS.md`). By mid-October a one-month chart on the
deployed site is empty, and every screen with a relative window degrades the same way on its own
schedule.

The banner (§4.5) would make that honest. It would not make it useful. **The fix is to anchor the
data axis to the snapshot**, and the model already has the axis: every function runs at
`ctx.asOf.validAt`, and `HP/window.ts#defaultWindowEnd` already ends windows at it. In replay mode the
runner should set `validAt` to the snapshot's capture date while the OPERATIONAL clock — sessions,
rate-limit refills, staleness sweeps, usage timestamps — stays real. A frozen operational clock would
stop the rate limiter's buckets refilling, so the two must not be the same clock.

That is one decision in `functions/runner.ts`, a `REPLAY_AS_OF` setting read from the seed's own
capture date, and the banner reading the same value. **Medium**, and it belongs before deploy: a demo
link that shows empty charts three weeks after it was sent is worse than no demo.

## 4. Code that does not exist yet

Five items. Sizes are my estimate of the work, not of the diff.

### 4.1 A way to sign in — DONE (2026-10-06): a login form with email codes

**Built: a real login form, with a second factor by email code.** It plugs into the MFA gate the
session model already has — a password-verified session that still owes a second factor may only
reach `/auth/*` — rather than inventing one. Accounts are created by whoever runs
`scripts/create-user.ts` (no public sign-up, matching SEC-01's one-row-per-natural-person design);
codes are six digits from a CSPRNG, stored as a keyed hash, valid ten minutes, single-use, bound to
the session that asked, five wrong guesses and dead. Mail goes out over SMTP so any provider works, and
**no configured transport means no code is sent** — never a code in a log. The contract is API.md
§15; the tests are `test/integration/auth/mfaEmail*.test.ts` and `e2e/tests/login.spec.ts`.

An email code is a real second factor but **not a phishing-resistant one** — a page that proxies the
sign-in can relay the code as easily as the password. For a demo that is a sound trade; it is not
what SEC-02 asks for, and WebAuthn (built, no UI yet) remains the answer to that.

What the deployment needs for it:

- **On Render's free plan, port 2525.** Render blocks outbound 25, 465 and 587 on free web services
  (since September 2025); Brevo's relay also listens on 2525, and `render.yaml` uses it. If 2525 is
  ever blocked too, the fallback is a sender that uses Brevo's HTTPS API, which no host blocks — a
  small addition to `email/sender.ts`, not written yet.
- `EMAIL_TRANSPORT=smtp`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (`starttls`),
  `SMTP_USER`, `SMTP_PASS` in the host's secret store (`.env.example` lists them). `EMAIL_FROM` must
  be an address the provider will send as — a verified domain, or the mailbox you authenticate as.
  The plant logs the transport at startup (never the password); with none it warns, and every
  sign-in that needs a code stops at "could not be sent".
- **Never `EMAIL_TRANSPORT=outbox` in production**: it writes live codes to the server's disk. The
  plant warns about it at startup in capitals for exactly this reason.
- The order on first deploy: migrate → seed → **disable the seven seeded accounts** (§5 item 1) →
  `create-user` for each real person → only then share the URL.

The options considered before the decision, kept for the record. When this was written, `App.tsx`
had no login form at all: sessions were minted by `POST /api/v1/auth/login` against a seeded user,
and a visitor to the public URL would have got a gate message telling them to send a request with
curl.

Two options, and I recommend the second for a public demo:

- **(a) A real login form.** A small component posting to the existing route. Honest, and the
  terminal then has the sign-in screen it has never had. But it needs a credential to hand out, and
  a public credential is §5's problem wearing a hat.
- **(b) A demo-session route.** `POST /api/v1/auth/demo` mints a session for one `role='user'`
  account with the `delayed` tier and no export scope, rate-limited per IP, behind an explicit
  `DEMO_LOGIN=1` env flag so it can never be on by accident in a real deployment. The web app calls
  it once when the session read returns 401. No password exists to leak.

(b) also keeps the six other seeded personas unreachable, which §5 wants anyway. **Medium**, mostly
because it needs its own tests and an entitlement review — a demo route that accidentally grants the
`admin` persona is the worst possible bug here.

### 4.2 Fastify serves the SPA — REQUIRED

`@fastify/static` on `packages/web/dist`, registered **after** the API routes, with an
SPA fallback in the existing `setNotFoundHandler` (`http/errors.ts` L253) that returns `index.html`
for a non-`/api` GET and leaves the current JSON 404 for everything else. Build without source maps
(7.4 of the 10 MB is maps). **Small.**

### 4.3 Rate limiting — EXISTS; one thing to check behind a proxy

**This section said there was no rate limiter and no login throttling. That was wrong.** The search
that produced it was truncated by a `head -6` before it reached `http/routes/auth.ts`, and I wrote the
conclusion without noticing the output had been cut. What is actually there, and is good:

- `http/rateLimit.ts` — per-session token buckets from API.md §8, used by **17 route files** including
  `functions.ts`: REST 20 req/s burst 60, `/search` 30 req/s, heavy `/data` 5 req/s, exports 2 req/s and
  60 per hour. Keyed on the server-minted session, never on a header — its own docstring explains that
  `X-Forwarded-For` is typed by the caller, so a limiter keyed on it has unlimited buckets.
- `POST /auth/login` — **5 attempts per 60 s per IP AND per email**, and an unknown address costs the
  same password work as a known one (`burnPasswordWork`), so the route cannot be used to discover
  which accounts exist.

**The one real wrinkle, and it is the host's, not the code's.** The login limiter keys its IP bucket
on the socket peer, which the kernel decides. Behind a host's reverse proxy every login arrives from
the PROXY's address, so the per-IP bucket is shared by every user of the site — five logins a minute
for everyone together. The per-email bucket, which is what actually stops a brute force against one
account, is unaffected. For a small demo that is tolerable; for anything larger, read the client
address from the proxy's own header **only** for a proxy the host documents and pins, and decide it
in config, never by trusting `X-Forwarded-For` from anyone. **Small**, and it waits for the host.

### 4.4 A trimmed seed — OPTIONAL, recommended

A `SEED_UNIVERSE_LIMIT` honoured by `seed/universe.ts`, keeping the instruments the seeded
workspaces and the e2e specs actually reference plus the top N by index membership. Takes 141 MB to
roughly 45 and shortens restore and cold start. **Medium** — the limit has to be applied where the
FK graph stays whole, which means at the universe module rather than as a `DELETE` pass afterwards.

Skip it if the host's tier is comfortable; take it if you are near 500 MB.

### 4.5 The snapshot banner — SMALL, and I think it is not optional

One line in the status bar: the seed's as-of date and that the data is a frozen replay snapshot, read
from `/health` rather than hardcoded. Everything else in this build states what a number is worth;
a public deployment that silently shows four-week-old prices as though live would be the one place it
stopped doing that.

---

## 5. Security — what must not ship

1. **The shared seeded password.** All seven accounts use `correct horse battery staple`. With the
   login form built (§4.1), disable them right after the seed and before the URL is shared — login
   refuses any account whose `status` is not `active`, so one statement does it:

   ```sql
   UPDATE users SET status = 'deprovisioned', deprovisioned_at = now()
    WHERE email LIKE '%@demo.terminal' OR email LIKE '%@newsco.terminal';
   ```

   Then `scripts/create-user.ts` for each real person. Do not deploy the fixture value as a working
   credential.
2. **`SESSION_SECRET`** — 32+ random bytes from the host's secret store, never in git. The config
   enforces 16 characters minimum; that is a floor, not a target.
3. **`RP_ID` / `RP_ORIGIN`** — leave them UNSET. There is no WebAuthn UI, and unset means every
   `/auth/webauthn/*` route fails closed (`config.ts` L55-70). That is the correct posture; the
   variables exist precisely so the anti-phishing checks can never be derived from the request's own
   `Host`.
4. **`METRICS_TOKEN`** — set it, or `GET /metrics` refuses every non-loopback scrape. Already
   fail-closed, so forgetting it is safe; setting it is better.
5. **`PUBLIC_FIELDS=1`** is a reasonable choice here. The field dictionary is documentation —
   definitions, units, decimals, licence terms, no instrument and no price — and publishing it lets a
   reader see the schema. Your call.
6. **The app connects as `terminal_app`, never as the database owner.** Row-level security is what
   keeps one firm's rows from another. Six tables `FORCE` it, so it binds even their owner — the four
   portfolio tables, `messages` and `data_exceptions` — but the other fourteen do not, and the owner
   that ran the migrations bypasses them: workspaces, watchlists, alerts, chat rooms and their
   members, message reads and reviews, annotations, saved searches, help tickets, legal holds and
   surveillance hits. So `DATABASE_URL` must name `terminal_app`, and `DATABASE_URL_MAINT`
   `terminal_maint`. Migration 0015 creates both roles WITHOUT passwords, so they cannot log in until
   §7.1 step 4 gives them one. Nothing has yet run the whole application as `terminal_app` — every
   local run and every browser test connects as a superuser — so the first deploy is also the first
   time a missing grant could show (§7, item 12).
7. **RLS is on, and every account is in exactly one firm.** `create-user --firm` requires a firm that
   already exists and puts the person in it; RLS keeps them inside it.

---

## 6. Hosts

**Chosen (2026-10-07): Render for the server, Neon for Postgres.** The table below is how the choice
was framed; the facts after it were checked against Render's own documentation on the day.

| Role | Candidates | What to check |
| --- | --- | --- |
| Postgres | **Neon**, Supabase | `CREATE ROLE` (§2.3) · ≥500 MB · PG 14+ · the 4 extensions · wakes on connect |
| Node + WS | **Render** free web service, Koyeb, Fly.io | WebSocket upgrades proxied · persistent process · RAM at build time (see below) · cold-start behaviour |
| Both, raw | **Oracle Cloud Always Free** | 4 ARM cores / 24 GB, genuinely always-free and no size limits — but you own Postgres, nginx, TLS renewal and systemd |

**Render's free plan, as it bears on this build:**

| Fact | Consequence here |
| --- | --- |
| 512 MB RAM, 0.1 CPU at runtime | Fits: the built server measured 170-190 MB resident under load |
| Builds run on a separate 2 CPU / 8 GB machine; 500 build minutes a month | Building on Render is fine — the build measured ~25 s with a 1.4 GB peak. "Build off-host" (below) is not needed |
| Spins down after 15 idle minutes; the next request or WebSocket wakes it in about a minute | The cold start below. It also restarts the process often, which §7 item 11 uses |
| Outbound SMTP on ports 25, 465 and 587 is blocked (since September 2025) | Sign-in codes go through Brevo on port 2525 (§4.1, `render.yaml`) |
| No shell, no one-off jobs, and no pre-deploy command (that is paid-only) | Migrations and the seed cannot run on Render; they run before the first deploy (§7.1) |
| Ephemeral filesystem | Never `EMAIL_TRANSPORT=outbox` there; nothing else writes files |
| 750 free instance hours per workspace per month | One service running all month is 744 |

Two practical notes:

- **Build off-host — not needed on Render.** This note predates the measurement above: a 512 MB
  instance would likely OOM running `tsc -b` plus `vite build`, but Render does not build on the
  instance. On a host that does, build in CI and deploy the artifacts.
- **Cold starts are the free tier's real cost.** A service that spins down after 15 minutes idle
  takes about a minute to answer the first request, and this app loads a workspace and four functions
  on first paint. A demo link someone clicks cold will look broken for a minute. Oracle's always-free
  VM is the only option in the table without this problem.

---

## 7. Division of labour

### Step 0 — DONE

1. ~~Create a free Postgres and run the probe~~ — Neon passed on 2026-10-06 (§2.3b).
2. ~~Confirm the Node host proxies WebSockets~~ — a free Render service "spins back up whenever it
   next receives an HTTP request or new WebSocket connection", in Render's own words.
3. ~~Decide §4.1~~ — a login form with email codes, built.

### Mine

| # | Work | Size |
| --- | --- | --- |
| ~~0~~ | ~~The Postgres 14 → 18 move (§2.3b)~~ — **DONE**: schema identical, suite green on 18; it found and fixed a collation dependency, a microsecond-truncation bug in the bitemporal write path, a rotting e2e spec and a parser defect (`BUILD_STATUS.md`) | ~~L~~ |
| 1 | §4.2 Fastify serves the SPA, with the SPA fallback and a no-sourcemap build. **Until this lands the site's root URL is a JSON 404** — the API is up, the web app is not served | S |
| 2 | §4.3 ~~rate limiter~~ — it exists. What remains: the client address behind Render's proxy, decided in config | S |
| ~~3~~ | ~~§4.1 login form + email second factor, SMTP transport, `create-user` script~~ — **DONE**: with abuse tests (guess budget, single use, expiry, session binding, concurrent sends, resend limits, fail-closed transport, grants as `terminal_app`) and a browser spec that signs in with real keystrokes. It found a keyboard bug that swallowed every keystroke on the sign-in screen, and a first-load race that answered a new account's workspace with a 500 (`BUILD_STATUS.md`) | ~~L~~ |
| 4 | §3.1 anchor the data axis to the snapshot in replay mode (`REPLAY_AS_OF`), so relative windows do not empty out | M |
| 5 | §4.5 the snapshot banner, read from `/health`, showing the same as-of | S |
| ~~6~~ | ~~The host's build config~~ — **DONE**: `render.yaml`, a Render Blueprint. Its build and start commands were run on a fresh clone; its settings were passed through the server's own configuration check; and the server it starts was driven as `terminal_app` against a Neon-like database (§7.1) | ~~S~~ |
| 7 | A GitHub Actions workflow: typecheck, lint, the full suite (with `autoDeployTrigger: checksPass`, Render then deploys only green commits) | M |
| 8 | A GitHub Actions "prepare database" job — the §7.1 steps 2-3 from a GitHub runner, which can reach Neon when your network cannot | M |
| 9 | §4.4 the trimmed seed, only if your tier needs it | M |
| 10 | `docs/RUNBOOK.md` — rotate the secret, re-seed, read `/health`, what `degraded` means | S |
| 11 | **Partition horizon — before 1 December 2026.** `access_log` and `usage_events`, written on every request, have monthly partitions only through November; the job that adds more belongs to the scheduler that is off. Extend them at every start, on `DATABASE_URL_MAINT` (`BUILD_STATUS.md`) | S |
| 12 | The browser suite with the server connected as `terminal_app`, so a missing grant shows in a test rather than on the site | S |
| 13 | Migration 0015 fails for an owner that is not a superuser (`must be able to SET ROLE "terminal_maint"`). §7.1 step 2 works around it; the fix is a self-grant inside the migration | S |
| 14 | Optional: a sender for Brevo's HTTPS API, if port 2525 is ever blocked too | S |

Every one of those goes through the same gate as the rest of this build: typecheck, lint, the full
vitest suite twice, the e2e suite, and mutation-checks on anything with a security consequence.

### Yours

| # | Work | Why it cannot be mine |
| --- | --- | --- |
| ~~1~~ | ~~Create the accounts~~ — Render, Neon and Brevo exist; the repository is on GitHub | — |
| 2 | §7.1 — the database, the two role passwords, the Brevo sender and SMTP key, the Blueprint | Every one is a credential I must never see |
| 3 | `create-user` for each real person against the production database (§7.1 step 6) | It prompts for each person's password |
| 4 | Tell me the URL once it is up | — |
| 5 | A custom domain and its DNS, if you want one | Registrar access |
| 6 | Confirm you accept the free tier's terms for this use | Your decision, not mine |

`git push` is yours, as it always is in this project. The repository is public, so GitHub Actions
minutes are free.

### 7.1 Setting it up on Render and Neon, step by step

Verified on 2026-10-07 against a stand-in for Neon: a fresh Postgres 18.6 cluster whose owner, like
`neondb_owner`, is not a superuser but holds `CREATEROLE` and `CREATEDB`. On it, the steps below
applied all 20 migrations, seeded the universe in about a minute, and ran the built server as
`terminal_app` through sign-in, a workspace save, six function runs, a new watchlist, a chat
message, usage events, a second login that superseded the first, and logout — with no permission
error, and the audit rows written. **Step 2 is not optional:** without it, migration 0015 stops
with `must be able to SET ROLE "terminal_maint"`.

Steps 3 and 6 need a connection to Neon on port 5432, which the development machine's network
blocks (§2.3). Run them from a network that does not (a phone hotspot usually works) — or wait for
item 8, which runs them from GitHub instead.

1. **Neon — the database.** In the SQL Editor, on the default database:

   ```sql
   CREATE DATABASE terminal LOCALE 'C' TEMPLATE template0;
   ```

   If Neon refuses the `LOCALE` or `TEMPLATE` part, run `CREATE DATABASE terminal;` instead; the
   server then logs a collation warning at startup and works the same (§2.3b). Every connection
   string from here on names the `terminal` database — Neon's Connect dialog lets you choose it.

2. **Neon — the two application roles, BEFORE migrating.** Still in the SQL Editor:

   ```sql
   CREATE ROLE terminal_app LOGIN;
   CREATE ROLE terminal_maint LOGIN;
   GRANT terminal_maint TO neondb_owner;   -- lets the migration hand it the partitioned tables
   ```

   (If your owner role is not called `neondb_owner`, use its name.) Migration 0015 finds the roles
   already there and skips creating them.

3. **Migrate and seed**, from the repository root, with Neon's **direct** (not pooled) connection
   string for `terminal` as the owner:

   ```bash
   read -rs NEON_URL        # paste the string and press Enter; nothing is echoed or kept in history
   npx tsx scripts/migrate.ts --url "$NEON_URL"
   npm run db:seed -- --url "$NEON_URL"
   ```

   `read -rs` also keeps zsh from tripping over the `?` in the URL (§2.3). The seed uploads about
   150 MB, so over a phone connection expect minutes rather than seconds.

4. **Neon — passwords, and the demo accounts off.** In the SQL Editor, on `terminal`:

   ```sql
   ALTER ROLE terminal_app WITH PASSWORD '<password A>';
   ALTER ROLE terminal_maint WITH PASSWORD '<password B>';
   UPDATE users SET status = 'deprovisioned', deprovisioned_at = now()
    WHERE email LIKE '%@demo.terminal' OR email LIKE '%@newsco.terminal';
   ```

   Make each password with `openssl rand -hex 24`: hex needs no escaping inside a connection string,
   and 192 bits is well over Neon's 60-bit minimum.

5. **Brevo.** Add and verify the sender address the codes will come from. Then, in the SMTP & API
   settings, on the SMTP tab, copy the SMTP login and generate an **SMTP key** (not an API key).

6. **Your account**, from the same reachable network as step 3:

   ```bash
   npx tsx scripts/create-user.ts --email <your address> --name "<your name>" --firm "Demo Capital" --url "$NEON_URL"
   ```

   It asks for your password twice, and the account signs in with an emailed code.

7. **Render — the Blueprint.** New → Blueprint → the `bloomberg` repository. Render reads
   `render.yaml`, generates `SESSION_SECRET` and `METRICS_TOKEN`, and asks — this once only — for:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon's **pooled** string for `terminal`, with `neondb_owner:<its password>` replaced by `terminal_app:<password A>` |
   | `DATABASE_URL_MAINT` | Neon's **direct** string for `terminal`, with the owner replaced by `terminal_maint:<password B>` |
   | `SMTP_USER` / `SMTP_PASS` | the SMTP login and SMTP key from step 5 |
   | `EMAIL_FROM` | `Terminal <the verified sender>` |

   A value skipped here has to be added later by hand, under the service's Environment tab.

8. **Check it.** `https://<the service>.onrender.com/api/v1/health` answers 200 with
   `"status":"degraded"` — degraded is normal here (§3). Until item 1 lands, the root URL is a JSON
   404: the API is live, the web app is not served yet.

### Sequence

```
step 0 ✓  →  item 0 ✓  →  item 3 ✓  →  item 6 ✓ (render.yaml)
          →  1, 11 (me: needed before the site is usable and before 1 December)
          →  4, 5, 12, 13 (me)  →  §7.1 (you)  →  7, 8, 2, 10 (me)  →  9 if needed
```

Item 1 is what makes the URL show the terminal at all, and item 11 has a date on it. §7.1 can start
any time — the database steps do not depend on any of my items — but a deploy before item 1 shows
only the API.

---

## 8. Costs that can appear on a free tier

Not to talk you out of it — to make sure the first surprise is in this document and not on a bill.

- **Egress.** The first load is ~2.6 MB of JavaScript without maps. A thousand cold loads is ~2.6 GB.
  Most free tiers include enough; some meter it.
- **Database storage.** Nothing grows except `access_log`, `usage_events` and `sessions`, and those
  are the three the scheduler being off does not stop. Over months on a 500 MB tier that matters, so
  §7 item 10's runbook includes a retention trim.
- **Hitting the ceiling.** The failure mode of a free tier is usually a suspended service rather than
  a charge. Decide now whether you want a card on the account at all; without one you cannot be
  charged, and the site stops instead.

---

## 9. What I would not do

- **Two origins.** §2.1. It costs three changes, one of which weakens a cookie defence.
- **Serverless.** §2.2. The socket and the plant are stateful; there is no version of this that fits.
- **Turning the scheduler on.** §3. It needs a design decision made first, it would put a shared
  host's IP under SEC and Cboe rate limits, and it outgrows the tier.
- **Shipping the seeded password.** §5. It is in a committed document, which means it is already
  public; the only question is whether it opens anything.
