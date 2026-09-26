# Terminal

A working recreation of the Bloomberg Terminal: a keyboard-first financial workstation with a
real-time quote plant, 38 function screens, bitemporal market data, entitlements, a canvas chart
engine and an audit trail on every number.

It runs offline. Every value it shows comes from a recorded capture of a public source, replayed
through a fixture store, and every value carries a provenance row saying which source, which
message and which timestamp produced it. There are no vendor keys and no live feed.

```
38 screens · 154 tables · 19 migrations · 5,915 unit/integration tests · 39 browser tests
```

---

## Quick start

**You need:** Node ≥ 22.19, PostgreSQL 14 running locally, and Google Chrome (for the browser
tests only).

```bash
npm install
cp .env.example .env              # already sane for local use
createdb bloomberg_dev
npm run db:migrate                # 19 migrations, 154 tables
npm run db:seed                   # ~3½ minutes, offline, idempotent (re-running writes nothing)
npm run dev                       # plant on :8080, app on :5173
```

Then open <http://localhost:5173>.

### Signing in

**The terminal has no sign-in screen, by design.** A session is minted by the plant and the web
client only ever _reads_ `GET /auth/session`. With no session you get a gate that says so.

The quickest way in: open <http://localhost:5173>, open your browser's devtools console, and paste

```js
await fetch('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'terminal' },
  body: JSON.stringify({
    email: 'pm@demo.terminal',
    password: 'correct horse battery staple',
    deviceId: 'd_mylaptop01',
  }),
}).then((r) => r.json());
```

then reload the page. The response sets an `HttpOnly` cookie, so this has to happen in the browser
rather than in a terminal — the app runs through Vite's `/api` proxy, which makes the request
same-origin and the cookie usable.

All seven seeded accounts share that password (it is the one in `docs/API.md` §12.1, and it is
**development only**):

| Account                    | Role            | Why it exists                                                                                                                      |
| -------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pm@demo.terminal`         | Equities PM     | the default desk — a four-panel workspace                                                                                          |
| `analyst@demo.terminal`    | Equity Research | owns a different watchlist                                                                                                         |
| `rates@demo.terminal`      | Rates           | curve and swap screens                                                                                                             |
| `compliance@demo.terminal` | Compliance      | surveillance and the message archive                                                                                               |
| `dataops@demo.terminal`    | Data Operations | ingest and data-quality screens                                                                                                    |
| `eod@demo.terminal`        | Equities PM     | **entitled only to end-of-day prices, and denied export** — the account to log in as if you want to see the entitlement rules bite |
| `reporter@newsco.terminal` | Newsroom        | a different firm: news, nothing priced                                                                                             |

---

## Using the terminal

It is a command line and a grid of panels. The command line takes a security, a function, or both:

```
AAPL US Equity DES      a security and a function
DES                     a function, run against the security the panel already holds
AAPL US Equity          a security, run through the function the panel is already showing
```

Press `Enter` (`GO`) to run. `Enter` runs **what you typed**, not the highlighted autocomplete row —
arrow down first if you want a suggestion.

`Shift+Enter` runs it in the next panel.

Each widget owns its keys at the element, and those work: arrows move within a grid, `Enter` on a
grid row runs that row's own command, `Ctrl+I` on a focused cell opens the provenance panel for that
number, and the chart has its own crosshair, zoom, study-picker and draw-mode keys (`docs/CLIENT.md`
§11.9). `Tab` moves between panels and nodes in document order.

**The window-level keys are not bound yet.** `keyboard/dispatcher.ts` is complete and tested but is
not attached, because its host needs the focus model that `Panel.tsx` holds privately — the reasoning
is in a comment at the top of `packages/web/src/App.tsx`. So `F1`, `PRINT`, `PAGE FWD/BACK`, the
panel-switch chords and type-anywhere do nothing at the window. Everything they reach is reachable
another way: `HELP` is a command and typing it twice within ten seconds opens the ticket exactly as
the key would; `/panel`, `/layout` and `/clear` are shell commands; the frame stack has visible
back/forward buttons. The one exception is `PRINT`: `ScreenCtx.export` is wired and a screen's own
control works, but there is no global key for it.

Shell commands start with `/`:

| Command                      | Effect                                                     |
| ---------------------------- | ---------------------------------------------------------- |
| `/layout 1 \| 2h \| 2v \| 4` | panel layout — one, two side by side, two stacked, or four |
| `/panel <n>`                 | focus a panel                                              |
| `/theme light \| dark`       | theme                                                      |
| `/conflate <ms>`             | change the quote conflation interval                       |
| `/clear`                     | clear the panel's frame stack                              |
| `/logout`                    | end the session                                            |

### The 38 screens

|                          |                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security & reference** | `DES` description · `SECF` security finder · `HDS` holders · `MEMB` index members · `CACS` corporate actions                                          |
| **Pricing & quotes**     | `Q` quote · `QM` quote monitor · `GP` price graph · `GIP` intraday · `HP` historical prices · `W` watchlist                                           |
| **Fundamentals**         | `FA` financial analysis · `EE` earnings estimates · `CF` cash flow · `RV` relative value · `EQS` equity screener                                      |
| **Fixed income & rates** | `YAS` yield and spread · `SWPM` swap manager · `CRVF` curve fitting · `GC` generic curve · `FED` Fed · `WIRP` rate probability · `BTMM` money markets |
| **Derivatives**          | `OMON` option monitor · `OVML` option valuation                                                                                                       |
| **Macro & news**         | `ECO` economic calendar · `N` news · `NI` news by topic · `CN` company news · `TOP` top news · `WB` world bonds · `WEI` world equity indices          |
| **FX & crypto**          | `FXC` FX rates · `CRYP` crypto                                                                                                                        |
| **Portfolio & workflow** | `PORT` portfolio · `SRCH` search · `MSG` messages · `HELP` help (twice opens a ticket)                                                                |

Type `HELP` for an explanation of whatever the panel is running; type it twice to open a support
ticket.

---

## What is in the repository

Five npm workspaces under `packages/`.

| Package            | Lines | What it is                                                                                                                                                                                                                                                |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@terminal/core`   | ~50k  | Pure domain logic: the field dictionary, day counts and calendars, bond/swap/option analytics, curve bootstrapping, statistics, corporate-action adjustment, the command grammar and ranking, the formula language, and the 38 function manifests. No IO. |
| `@terminal/sdk`    | ~9k   | The client's view of the wire: REST client, the live WebSocket client with the prev-chain rule, the ref-counted subscription manager and the quote cache.                                                                                                 |
| `@terminal/server` | ~136k | Fastify plant: the ticker plant and conflator, the WebSocket gateway, entitlements and quotas, the function runner and REST routes, provider adapters and the replay store, ingest jobs, the bitemporal write layer, and the thirteen seed modules.       |
| `@terminal/web`    | ~40k  | React 19 client: the shell and panels, the command line and autocomplete, the virtualised live grid with imperative cell updates, the canvas chart engine with 22 studies, and the 38 screen components.                                                  |
| `@terminal/e2e`    | ~8k   | Playwright specs that drive the composed application in Chrome.                                                                                                                                                                                           |

### How a keystroke becomes a number on screen

```
command line → core/command (parse + rank) → dispatch
             → POST /api/v1/functions/<code>/run
             → function runner → resolver → data services → Postgres
             → payload + meta.provenance[]
             → screen component → ScreenSpec → ScreenRenderer → widgets
                                                      ↓
                      live cells register with grid/cellRegistry by (subject, field)
                      ↑
       WebSocket ← ticker plant ← conflator ← provider adapters ← replay store ← fixtures
```

Two rules shape most of the code:

- **Every number cites its source.** A payload cell carries a `provIdx` into `meta.provenance[]`,
  the grid writes it onto the DOM as `data-prov-idx`, and `Ctrl+I` reads it back. A resolver that
  returns a number with no provenance fails its own tests.
- **Every number carries a state.** `live`, `stale`, `closed`, `blank` and `na` render
  distinguishably, and a value withheld by entitlement is null with a reason code rather than a
  silently missing field.

---

## Where the data comes from

No vendor feed, no API keys. The captures in `fixtures/providers/raw/` (48 of them) come from
public sources: Cboe delayed quotes and the symbol book, SEC EDGAR (company facts, submissions,
N-PORT), OpenFIGI, Yahoo chart endpoints, the US Treasury par curve, the Federal Reserve H.15, the
New York Fed reference rates, FRED, BLS, the World Bank, IMF WEO, CoinGecko and Bloomberg's own
public RSS feeds.

`PROVIDER_MODE=replay` is the default and the only mode the tests run in. **The replay store is a
wall**: a request with no recorded capture throws rather than reaching the network, so a test can
never quietly depend on the internet. `npm run fixtures:record` is the only path that talks to a
real source.

The seed writes ~41,000 instruments, ~85,000 identifiers, 25,000 XBRL facts, 17,000 economic
observations, 1,264 daily and 1,033 intraday bars, 3,510 option contracts, 160 news items and
7 users — all of it from those captures, every row citing one.

---

## Testing

```bash
npm test                # 5,915 tests, 254 files, ~4 minutes
npm run test:e2e        # 39 browser tests in Chrome, ~3.5 minutes
npm run typecheck
npm run lint
```

`npm test` is nine Vitest projects, split because some suites cannot share a machine with their
neighbours:

| Project         | What it covers                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `core`, `sdk`   | pure logic, no database                                                                                       |
| `server-unit`   | the plant without a database                                                                                  |
| `server-int`    | integration, four forks against one database, each test in a rolled-back transaction                          |
| `server-serial` | suites that take table locks (partition DDL) or deadlock on seeding order — one at a time                     |
| `server-seed`   | the seed's own assertions, and **the only project that seeds**; it owns `bloomberg_seed_test`                 |
| `server-replay` | whole ingest jobs driven from recorded captures                                                               |
| `web`           | jsdom, with a manual frame pump — no web test waits on a timer                                                |
| `web-bench`     | the three suites that assert a wall-clock frame budget, run alone so they measure the code and not the runner |

**Three databases, deliberately.** `bloomberg_dev` is yours. `bloomberg_test` is migrated but
**never seeded** — ~145 integration tests assert what their own job inserted into an empty table.
`bloomberg_seed_test` holds the seeded universe for the seed and browser suites. The reasoning is in
`packages/server/test/globalSetup.ts`.

The browser suite provisions its own database per slot, so several runs can coexist:

```bash
TERMINAL_E2E_SLOT=7 npm run test:e2e     # its own ports and its own database copy
```

Other useful commands:

```bash
npm run replay:run      # replay a recorded plant session and diff it against the golden
npm run db:reset        # drop and re-migrate
npm run gen:functions   # regenerate the screen/manifest registries (they are generated, not hand-edited)
```

---

## Known gaps

`BUILD_STATUS.md` is the honest list, with evidence and file references for each item. The short
version:

- Eight behaviours are asserted by browser specs marked `test.fail` — they run on every suite and
  turn red the day someone fixes them. Notably: a withheld cell is not yet distinguishable from a
  missing one; the client's staleness sweep never reaches a cell; nothing in the UI invokes export;
  and a restored panel loses its instrument on a second load.
- No grid subject is ever subscribed — `state/subscriptions.ts#acquire` has no caller, so the live
  grid draws from its payload and only the chart subscribes. This is the first thing to fix: it also
  blocks pointing the default chart panel at a security that has history.
- Five startup steps in the plant still defer to work packages that have since landed, so
  `GET /health` reports `degraded`.
- Two panels of the default workspace have a layout defect and draw over themselves.
- `chart/scales.ts` is 761 lines that nothing imports; the renderer carries its own copy.

---

## Documentation

The design is written down, and it is the authority the code is checked against.

| Document                                     | What it fixes                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `docs/BRIEF.md`                              | the wedge, the stack, the non-goals                                                                 |
| `docs/REQUIREMENTS.md`                       | 158 numbered requirements, the ids cited throughout the code                                        |
| `docs/ARCHITECTURE.md`                       | processes, the quote pipeline, startup order                                                        |
| `docs/DATA_MODEL.md`                         | all 154 tables, bitemporality, and the seed volumes                                                 |
| `docs/API.md`                                | every REST route and the WebSocket protocol                                                         |
| `docs/FUNCTIONS.md` + `FUNCTIONS_TIER1-3.md` | the 38 screens, field by field                                                                      |
| `docs/CLIENT.md`                             | the shell, the grid, the chart engine, the keyboard map, the frame budgets                          |
| `docs/PROVIDERS.md`                          | every source, its licence terms and its capture                                                     |
| `docs/TESTING.md`                            | the test strategy and the database harness contract                                                 |
| `docs/TRACEABILITY.md`                       | all 158 requirements mapped to implemented / partial / out of scope, with the test that proves each |
| `docs/WORKPLAN.md`                           | the fifteen work packages this was built in                                                         |
| `BUILD_STATUS.md`                            | what is done, what is open, and what was found the hard way                                         |
