# DEPLOYMENT — putting this terminal on a public URL for nothing

A plan, the measurements it rests on, and a division of labour. Nothing here has been done yet.

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

**The ten-minute test, before any other work** (§7, step 0) is `scripts/deploy-probe.sh`:

```bash
./scripts/deploy-probe.sh 'postgresql://user:pass@host/db?sslmode=require'
```

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

## 4. Code that does not exist yet

Five items. Sizes are my estimate of the work, not of the diff.

### 4.1 A way to sign in — REQUIRED, nothing works without it

`App.tsx` L22-23 and L483: **there is no login form anywhere in this repository.** Sessions are
minted by `POST /api/v1/auth/login` against a seeded user. A visitor to the public URL today would
get the gate message telling them to send a request with curl.

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

### 4.3 A rate limiter — REQUIRED before the URL is public

There is **none**. I checked: the only rate limits in the tree are *outbound* politeness to SEC and
Cboe. There is also no login throttling, no lockout, no failed-attempt backoff. On a public URL that
means an unthrottled brute-force target and an unthrottled `POST /functions/:code/run`, which is the
expensive route.

`@fastify/rate-limit`, global, with a tighter bucket on `/auth/*`. Note that `docs/API.md` §8's
quotas are *counted, not enforced* for web sessions, so they are not a substitute. **Small**, and it
is the difference between a demo and an open relay for your free compute.

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

1. **The shared seeded password.** All seven accounts use `correct horse battery staple`. Either
   take §4.1(b) and leave no password-reachable account enabled, or re-hash every seeded account with
   a secret only you hold. Do not deploy the fixture value.
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
6. **RLS is on and the demo persona should be one firm.** It works; §4.1(b)'s review is to confirm
   the demo account lands in the right firm with the `delayed` tier and no export scope.

---

## 6. Hosts

**I cannot verify current free-tier terms.** I have no network access in this session and these
change constantly — Render's free Postgres, Fly's free allowance and Railway's free plan have all
changed at least once. Treat the table as the *shape* of the choice and confirm the terms yourself
before building anything (§7 step 0).

| Role | Candidates | What to check |
| --- | --- | --- |
| Postgres | **Neon**, Supabase | `CREATE ROLE` (§2.3) · ≥500 MB · PG 14+ · the 4 extensions · wakes on connect |
| Node + WS | **Render** free web service, Koyeb, Fly.io | WebSocket upgrades proxied · persistent process · RAM at build time (see below) · cold-start behaviour |
| Both, raw | **Oracle Cloud Always Free** | 4 ARM cores / 24 GB, genuinely always-free and no size limits — but you own Postgres, nginx, TLS renewal and systemd |

Two practical notes:

- **Build off-host.** A 512 MB instance will likely OOM running `tsc -b` across five packages plus
  `vite build`. Build in CI (GitHub Actions is free for public repos) and deploy the artifacts, or
  build a container image locally and push it.
- **Cold starts are the free tier's real cost.** A service that spins down after 15 minutes idle
  takes ~30-60 s to answer the first request, and this app loads a workspace and four functions on
  first paint. A demo link someone clicks cold will look broken for a minute. Oracle's always-free
  VM is the only option in the table without this problem.

---

## 7. Division of labour

### Step 0 — yours, ten minutes, before I write anything

1. Create a free Postgres, copy its connection string, and run
   `./scripts/deploy-probe.sh '<that URL>'`. **Send me the output.** If `CREATE ROLE` fails, the plan
   changes shape and I would rather know now. A local run is not a substitute: your local role is a
   superuser and passes everything.
2. Confirm the Node host proxies WebSockets and says so in its own documentation.
3. Decide §4.1: a login form, or the demo-session route.

### Mine

| # | Work | Size |
| --- | --- | --- |
| 1 | §4.2 Fastify serves the SPA, with the SPA fallback and a no-sourcemap build | S |
| 2 | §4.3 rate limiter, global plus a tighter `/auth/*` bucket, with tests | S |
| 3 | §4.1 whichever option you chose, with its entitlement tests | M |
| 4 | §4.5 the snapshot banner, read from `/health` | S |
| 5 | A `Dockerfile` + `.dockerignore`, or the host's native build config | S |
| 6 | A GitHub Actions workflow: typecheck, lint, the full suite, build, publish the image | M |
| 7 | `scripts/deploy-migrate.ts` — migrate then seed against a remote `DATABASE_URL`, idempotent, calling `deploy-probe.sh` as its first step | M |
| 8 | §4.4 the trimmed seed, only if your tier needs it | M |
| 9 | `docs/RUNBOOK.md` — rotate the secret, re-seed, read `/health`, what `degraded` means | S |

Every one of those goes through the same gate as the rest of this build: typecheck, lint, the full
vitest suite twice, the e2e suite, and mutation-checks on anything with a security consequence.

### Yours

| # | Work | Why it cannot be mine |
| --- | --- | --- |
| 1 | Create the accounts (host, Postgres, and a GitHub remote if you want CI) | They need your email and card-on-file-for-identity |
| 2 | Generate `SESSION_SECRET` and `METRICS_TOKEN` and paste them into the host's secret store | I must never hold or print a production secret |
| 3 | Paste `DATABASE_URL` into the host's secret store | Same |
| 4 | Run step 0's probes and send me the output | Needs network |
| 5 | Press deploy the first time, and tell me the URL | Needs your credentials |
| 6 | A custom domain and its DNS, if you want one | Registrar access |
| 7 | Confirm you accept the free tier's terms for this use | Your decision, not mine |

`git push` to a public repository is yours too, as it always is in this project — and note that
making this repo public is what GitHub Actions being free depends on.

### Sequence

```
step 0 (you, 10 min)  →  1,2,4,5 (me)  →  3 (me)  →  6,7 (me)  →  deploy (you)  →  8,9 (me, if needed)
```

Items 1, 2, 4 and 5 are independent of which host you pick and I can start on them the moment you
have run step 0's probes. Item 3 depends on your §4.1 decision. Item 7 needs a live
`DATABASE_URL` to test against, so it is last.

---

## 8. Costs that can appear on a free tier

Not to talk you out of it — to make sure the first surprise is in this document and not on a bill.

- **Egress.** The first load is ~2.6 MB of JavaScript without maps. A thousand cold loads is ~2.6 GB.
  Most free tiers include enough; some meter it.
- **Database storage.** Nothing grows except `access_log`, `usage_events` and `sessions`, and those
  are the three the scheduler being off does not stop. Over months on a 500 MB tier that matters, so
  §7 item 9's runbook includes a retention trim.
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
