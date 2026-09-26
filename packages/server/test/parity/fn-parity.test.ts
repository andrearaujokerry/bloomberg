/**
 * `test/parity/fn-parity.test.ts` — API-05: **a number is the same number whichever door it comes
 * out of** (FUNCTIONS.md §8, WORKPLAN WP-15 acceptance row "every manifest × seed securities: JSON
 * payload = CSV export = WS snapshot").
 *
 * Every other function test in this repository asks whether one door answers correctly. This file
 * asks whether the three doors answer the *same*, and that is a different question with a different
 * failure mode: a formatter applied on the screen path and not the export path, a rounding done in
 * the CSV writer, an entitlement mask applied to the payload but not to the live snapshot, a null
 * rendered as an em dash in one place and an empty string in another. None of those is visible from
 * inside a single door, and all of them are the kind of defect a trader finds by reconciling a
 * spreadsheet against a screen.
 *
 * Three doors, one launch:
 *
 *  1. `POST /functions/:code/run`      — the JSON payload the screen renders.
 *  2. `GET  /functions/:code/csv`      — the file, fetched by the `resultId` of that same run, so
 *                                        it is the *same* cached payload and not a second resolve.
 *  3. `sub` over the real WebSocket    — the `snap` of every subject a `ValueCell.live` names.
 *
 * **The comparison is of values, never of bytes.** Three serialisations of one object are supposed
 * to differ; what may not differ is the value inside them. So:
 *
 *  - Every non-empty CSV cell under a `number`, `date`, `datetime` or `boolean` column must be an
 *    *exact* rendering of a value already in the payload, the parsed params, the payload envelope
 *    or the column list — the shortest round-trip decimal, `YYYY-MM-DD`, ISO-UTC, `true`/`false`.
 *    A cell reading `1,234.57` where the payload holds `1234.5678` is a failure twice over, for the
 *    separator and for the rounding. A `string` column carries prose, an enum or a joined list, so
 *    it is held to the narrower rule that a cell which *looks* like a number must be the payload's
 *    number at full precision. No cell of any type may be a "no value" marker where `serialiseCell`
 *    would write an empty field. This is the assertion that does the work, and it is deliberately
 *    *not* expressed as "re-run `toCsv` and compare", which would only prove the exporter agrees
 *    with itself.
 *  - Every `ValueCell` carrying `live: { subject, field }` must hold the value the gateway sends for
 *    that (subject, field) in its `snap`, and a `provIdx` resolving to the same `provenance_id` the
 *    snapshot cites (DATA-10). A cell the *entitlement* refused on the payload path must be refused
 *    on the socket too, for the same reason; a cell blanked for any other reason is the documented
 *    placeholder the WS cache fills, and only the mask is asserted for it.
 *
 * **Where the data comes from.** The acceptance row says "seed securities", so this file reads the
 * `server-seed` project's database (`bloomberg_seed_test`, DATA_MODEL §18) rather than seeding a
 * universe of its own: a parity test over two hand-made rows proves nothing about the catalogue.
 * Everything it writes — a session row, nothing else — happens inside one transaction that is
 * rolled back, and that transaction is also the app's database handle, so the routes read exactly
 * the seeded rows. It never touches `bloomberg_test`: ~145 committed ingest and function tests
 * assert what their own job inserted into empty tables there (see the second DEVIATION in
 * `test/globalSetup.ts`).
 *
 * **When the seed is not there** the file does not quietly pass. `PRECONDITIONS` is asserted by its
 * own test, which fails with a message naming the missing database and the command that produces
 * it, and every case then fails too because it has no observation to compare. A parity suite that
 * silently tests nothing is worse than no parity suite, because it reports green for a property
 * nobody checked.
 *
 * **WHICH VITEST PROJECT THIS RUNS IN.** `test/parity/**` is matched by `server-unit`'s
 * `test/**\/*.test.ts`, which has no `globalSetup` of its own and runs in scheduling group 0, while
 * the project that seeds this file's database (`server-seed`) runs its tests in group 2. That is
 * safe, and the reason is worth stating because it is not what the group numbers suggest: a
 * `globalSetup` is not scheduled with its project's tests. Vitest initialises every project's
 * global-setup file at the START of the invocation, sequentially, before the first test of the
 * first group — a full run prints globalSetup's four `migrate + seed` lines before any test file
 * output. So `server-seed`'s cold seed has already committed by the time this file's `beforeAll`
 * opens its pool, whatever group either project is in.
 *
 * Verified rather than reasoned about, on an empty migrated database standing in for a fresh
 * machine: `globalSetup: migrate + seed in 157676 ms`, then this file 167/167 and
 * `volumes.test.ts` 87/87 against what that seed had just written. Pointed at an unseeded database
 * with no `server-seed` in the invocation, 166 of its 167 fail with the precondition message — so
 * the suite still cannot pass vacuously, which is the property {@link PRECONDITIONS} exists for.
 *
 * This file therefore does NOT need a project of its own, and an earlier revision of this comment
 * asking for one was wrong on the mechanism. What group order would change is only running
 * `server-unit` ALONE, which seeds nothing and is not how the suite runs.
 *
 * **WHAT THIS FILE FOUND, and did not fix.** Six defects, each in a package this file may not edit,
 * each recorded by name so that it is neither hidden nor able to hide the next one: see
 * {@link CENSUS} (five resolvers that answer `500` against the seeded universe, two of them because
 * a seeded Treasury cannot be priced), {@link CSV_CENSUS} (twenty exports refused `403` for a field
 * with no `field_licence` row), {@link KNOWN_CELL_DEFECTS} (`FA`'s period columns typed `number`
 * and filled with text) and {@link KNOWN_LIVE_DEFECTS} (a field the payload refuses and the socket
 * serves). Each table is asserted exactly, so a fix turns the file red until the entry is deleted.
 */

import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FieldId, NormalisedUpdate, ValueCell } from '@terminal/core';
import {
  isoDateFromEpochMs,
  isoDateTimeFromEpochMs,
  numberToCsv,
  registry as generatedRegistry,
  manifests,
} from '@terminal/core';
import type { ServerMsg } from '@terminal/sdk/wire/ws';

import { getConfig } from '../../src/config.js';
import { setAmbientTx, type Tx } from '../../src/db/client.js';
import type { Plant } from '../../src/plant/tickerPlant.js';
import { createTestApp, type TestApp } from '../../src/test/app.js';
import { testClock, type VirtualClock } from '../../src/test/clock.js';
import { readNormalised } from '../../src/test/fixtures.js';

const { Pool } = pg;

/**
 * `PARITY_DEBUG=1` prints every refusal and every violation instead of only the first twelve.
 *
 * It exists because this file's failures are almost always about *another* package: the useful
 * question on a red run is "which cases changed and why", and the answer is eighty error bodies and
 * a few hundred cell addresses, which is too much for an assertion message and exactly right for a
 * flag.
 */
const DEBUG = process.env.PARITY_DEBUG === '1';

// `src/test/fixtures.ts` resolves `REPLAY_DIR` against `packages/server`, and the repository `.env`
// carries a root-relative path that lands one directory too deep. The captures are a fixed part of
// the repository, so the absolute path is pinned here, exactly as `test/integration/ws/helpers.ts`
// and `test/integration/plant/store.test.ts` do. It resolves to the same directory either way, so
// pinning it cannot change what any other file in this worker reads.
process.env.REPLAY_DIR = fileURLToPath(new URL('../../../../fixtures/providers', import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The seeded database
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `server-seed` project's database, which is the only one in the repository that holds the
 * DATA_MODEL §18 universe. `vitest.config.ts` defines the same default for that project.
 */
const SEED_DATABASE_URL =
  process.env.DATABASE_URL_SEED_TEST ?? 'postgres://localhost:5432/bloomberg_seed_test';

/**
 * How many current `instruments` rows make a database "seeded".
 *
 * §18 targets ≈36 k and the run this file was written against holds 41 455, so the floor is low
 * enough to survive a legitimate change to the universe module and high enough that a
 * migrations-only database (zero) or a per-test fixture (a handful) can never pass for the seed.
 */
const MIN_SEEDED_INSTRUMENTS = 1_000;

/**
 * The recorded `cboe-quote-AAPL` poll's own capture instant. The plant ticks this file publishes
 * are that fixture re-keyed, so the clock has to sit at it for a `snap` to be anything but stale —
 * the same choice `test/integration/ws/helpers.ts` makes and for the same reason.
 */
const GOLDEN_CAPTURE_MS = 1_789_497_688_000;

interface Precondition {
  ok: boolean;
  detail: string;
}

/** What the suite needs before it can assert anything; reported by its own test. */
const PRECONDITIONS: Precondition[] = [];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The case matrix: every manifest × a seeded security of each asset class it accepts
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One seeded security per asset class, named by the ticker the seed writes so the case matrix does
 * not hard-code a `bigserial` (TESTING §4.3). `option` has no stable ticker — the 3 510 contracts
 * are named from the chain — so it is resolved by asset class instead.
 */
const SECURITY_BY_CLASS: Record<string, { ticker: string } | { anyOfClass: string }> = {
  equity: { ticker: 'AAPL' },
  etf: { ticker: 'SPY' },
  index: { ticker: 'SPX' },
  fx: { ticker: 'EURUSD' },
  govt: { ticker: 'T 4.00 08/31/33' },
  crypto: { ticker: 'BTC' },
  rate: { ticker: 'SOFR' },
  option: { anyOfClass: 'option' },
};

interface ParityCase {
  /** `'DES×equity'`, `'QM'` — the test name and the census key. */
  name: string;
  code: string;
  /** `null` for a manifest that takes no security (`assetClasses: 'none'`). */
  assetClass: string | null;
}

/**
 * Every manifest, crossed with every asset class it declares for which the seed holds a security.
 *
 * Built from `manifest.assetClasses` rather than listed by hand: a manifest that gains an asset
 * class gains a parity case without anybody remembering to add one, and the census below then fails
 * until the new case is accounted for.
 */
function buildCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  for (const code of Object.keys(manifests).sort()) {
    const manifest = generatedRegistry.get(code);
    if (manifest === undefined) continue;
    const classes = manifest.assetClasses;
    if (classes === 'none' || classes === 'any') {
      cases.push({ name: code, code, assetClass: null });
      continue;
    }
    for (const assetClass of [...classes].sort()) {
      if (SECURITY_BY_CLASS[assetClass] === undefined) continue;
      cases.push({ name: `${code}×${assetClass}`, code, assetClass });
    }
  }
  return cases;
}

const CASES = buildCases();

/**
 * What each case did on the run this file was committed from: `'ok'` for a case that launched, or
 * the `AppError` code it answered with.
 *
 * This is a census, not a tolerance. A seeded universe does not hold data for every combination the
 * manifests allow — `FA` on an ETF has no XBRL facts, `OMON` on an index has no chain — and the
 * honest record of that is the error code the route returns, asserted by name. It makes the file
 * fail in both directions: a case that stops launching is a regression, and a case that *starts*
 * launching is a new parity surface that must be brought under the value assertions rather than
 * silently skipped. Regenerate it by reading the failure message, never by widening it.
 */
const CENSUS: Record<string, string> = {
  'BTMM': 'ok',
  'CACS×equity': 'ok',
  'CACS×etf': 'ok',
  'CACS×index': 'ok',
  'CF×equity': 'ok',
  'CF×etf': 'ok',
  'CN×equity': 'ok',
  'CN×etf': 'ok',
  'CN×index': 'ok',
  'CRVF': 'ok',
  'CRYP': 'ok',
  'DES×crypto': 'ok',
  'DES×equity': 'ok',
  'DES×etf': 'ok',
  'DES×fx': 'ok',
  'DES×govt': 'ok',
  'DES×index': 'ok',
  'DES×option': 'ok',
  'DES×rate': 'ok',
  'ECO': 'ok',
  'EE×equity': 'ok',
  'EQS': 'ok',
  'FA×equity': 'ok',
  'FA×etf': 'ok',
  'FED': 'ok',
  'FXC': 'INTERNAL',
  'GC': 'ok',
  'GIP×crypto': 'ok',
  'GIP×equity': 'ok',
  'GIP×etf': 'ok',
  'GIP×fx': 'ok',
  'GIP×index': 'ok',
  'GIP×option': 'ok',
  'GP×crypto': 'ok',
  'GP×equity': 'ok',
  'GP×etf': 'ok',
  'GP×fx': 'ok',
  'GP×govt': 'ok',
  'GP×index': 'ok',
  'GP×option': 'ok',
  'GP×rate': 'ok',
  'HDS×equity': 'INTERNAL',
  'HDS×etf': 'INTERNAL',
  'HELP': 'ok',
  'HP×crypto': 'ok',
  'HP×equity': 'ok',
  'HP×etf': 'ok',
  'HP×fx': 'ok',
  'HP×govt': 'ok',
  'HP×index': 'ok',
  'HP×rate': 'ok',
  'MEMB×index': 'ok',
  'MSG': 'ok',
  'N': 'ok',
  'NI': 'ok',
  'OMON×equity': 'ok',
  'OMON×etf': 'ok',
  'OMON×index': 'ok',
  'OVML×equity': 'ok',
  'OVML×etf': 'FUNCTION_NOT_APPLICABLE',
  'OVML×index': 'FUNCTION_NOT_APPLICABLE',
  'OVML×option': 'ok',
  'PORT': 'ok',
  'QM': 'ok',
  'Q×crypto': 'PROVIDER_UNAVAILABLE',
  'Q×equity': 'ok',
  'Q×etf': 'ok',
  'Q×fx': 'PROVIDER_UNAVAILABLE',
  'Q×index': 'ok',
  'Q×option': 'ok',
  'Q×rate': 'ok',
  'RV×equity': 'ok',
  'SECF': 'ok',
  'SRCH': 'INTERNAL',
  'SWPM': 'ok',
  'TOP': 'ok',
  'W': 'ok',
  'WB': 'ok',
  'WEI': 'ok',
  'WIRP': 'ok',
  'YAS×govt': 'INTERNAL',
};

/**
 * The same census for door 2: `'ok'`, or the code `GET /functions/:code/csv` answered with for the
 * `resultId` the launch produced.
 *
 * It is a separate record because a case can pass door 1 and fail door 2, and that combination is
 * the single most interesting thing this file has found: a screen whose values render but whose file
 * is refused. Recording it by name is what keeps it from being rounded off as "the export failed".
 */
const CSV_CENSUS: Record<string, string> = {
  'BTMM': 'ok',
  'CACS×equity': 'ok',
  'CACS×etf': 'ok',
  'CACS×index': 'INTERNAL',
  'CF×equity': 'ok',
  'CF×etf': 'ok',
  'CN×equity': 'ok',
  'CN×etf': 'ok',
  'CN×index': 'ok',
  'CRVF': 'ok',
  'CRYP': 'ok',
  'DES×crypto': 'ok',
  'DES×equity': 'ok',
  'DES×etf': 'ok',
  'DES×fx': 'ok',
  'DES×govt': 'ok',
  'DES×index': 'ok',
  'DES×option': 'ENTITLEMENT_DENIED',
  'DES×rate': 'ok',
  'ECO': 'ok',
  'EE×equity': 'ok',
  'EQS': 'ok',
  'FA×equity': 'ok',
  'FA×etf': 'ok',
  'FED': 'ok',
  'GC': 'ENTITLEMENT_DENIED',
  'GIP×crypto': 'ENTITLEMENT_DENIED',
  'GIP×equity': 'ok',
  'GIP×etf': 'ok',
  'GIP×fx': 'ENTITLEMENT_DENIED',
  'GIP×index': 'ok',
  'GIP×option': 'ENTITLEMENT_DENIED',
  'GP×crypto': 'ENTITLEMENT_DENIED',
  'GP×equity': 'ENTITLEMENT_DENIED',
  'GP×etf': 'ENTITLEMENT_DENIED',
  'GP×fx': 'ENTITLEMENT_DENIED',
  'GP×govt': 'ok',
  'GP×index': 'ENTITLEMENT_DENIED',
  'GP×option': 'ENTITLEMENT_DENIED',
  'GP×rate': 'ok',
  'HELP': 'ok',
  'HP×crypto': 'ENTITLEMENT_DENIED',
  'HP×equity': 'ok',
  'HP×etf': 'ok',
  'HP×fx': 'ENTITLEMENT_DENIED',
  'HP×govt': 'ok',
  'HP×index': 'ok',
  'HP×rate': 'ok',
  'MEMB×index': 'ok',
  'MSG': 'ok',
  'N': 'ok',
  'NI': 'ok',
  'OMON×equity': 'ENTITLEMENT_DENIED',
  'OMON×etf': 'ENTITLEMENT_DENIED',
  'OMON×index': 'ENTITLEMENT_DENIED',
  'OVML×equity': 'ENTITLEMENT_DENIED',
  'OVML×option': 'ENTITLEMENT_DENIED',
  'PORT': 'ok',
  'QM': 'ok',
  'Q×equity': 'ok',
  'Q×etf': 'ok',
  'Q×index': 'ENTITLEMENT_DENIED',
  'Q×option': 'ENTITLEMENT_DENIED',
  'Q×rate': 'ok',
  'RV×equity': 'ok',
  'SECF': 'ok',
  'SWPM': 'ok',
  'TOP': 'ok',
  'W': 'ok',
  'WB': 'ok',
  'WEI': 'ok',
  'WIRP': 'ok',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Thrown to force the held-open transaction to roll back; swallowed by the harness. */
class RollbackSignal extends Error {
  constructor() {
    super('parity harness rollback');
    this.name = 'RollbackSignal';
  }
}

interface Harness {
  tx: Tx;
  /**
   * The bitemporal pair every launch reads at, and the reason this file passes `asOf` explicitly
   * rather than letting the clock decide (FUNCTIONS.md §1.4.3 step 6).
   *
   * `knownAt` is the **wall clock**, not the virtual one. Every seeded row's `tx_from` is
   * `clock_timestamp()` at the instant the seed ran — today — so a `knownAt` on the virtual clock
   * (September 15th, where the recorded quote was captured) sees *none* of the universe. That is
   * not a hypothetical: it is what made `SPX`, `EURUSD`, `BTC`, `SOFR` and the option chain answer
   * `404 SECURITY_NOT_FOUND` while `AAPL` resolved, because the seed writes them in module order
   * and `instruments.tx_from` spans the whole run.
   *
   * `validAt` is the seed's own valid-time horizon, one second after the latest `valid_from` it
   * wrote. The obvious choice — the goldens' frozen `2026-09-15T18:41:28Z` — is three minutes
   * *before* the last instrument version the seed created, so it hides the newest rows.
   *
   * The `Clock` stays at the recorded poll's capture instant regardless, because staleness is
   * measured against it and a tick eleven days old would be `stale` on both doors: consistent, but
   * a comparison of two blanks rather than of two values.
   */
  asOf: { validAt: string; knownAt: string };
  client: pg.PoolClient;
  app: TestApp;
  clock: VirtualClock;
  plant: Plant;
  /** `Cookie:` header for the seeded PM (`users.user_id = 1`), who holds display AND export. */
  cookie: string;
  /** `ws://127.0.0.1:<port>/ws/v1`. */
  wsUrl: string;
}

let h: Harness | undefined;
let pool: pg.Pool | undefined;
let release: (() => void) | undefined;
let running: Promise<void> | undefined;

/**
 * Open the transaction, build the production app over it and start listening.
 *
 * One transaction and one app for the whole file, not one per test: every case reads the same
 * seeded rows and writes nothing but its own `access_log`/`usage_events` buffer, so a per-test
 * transaction would buy isolation nobody needs and pay for it with 60 app builds. The transaction
 * is published as the ambient one (`db/client.ts#setAmbientTx`) so the routes' own `withTx` opens a
 * SAVEPOINT inside it rather than a second connection that cannot see it.
 */
async function open(): Promise<void> {
  pool = new Pool({
    connectionString: SEED_DATABASE_URL,
    max: 4,
    options: '-c timezone=UTC',
    application_name: 'terminal-parity',
  });
  pool.on('error', () => undefined);

  const client = await pool.connect();
  const clientDb = drizzle(client);

  let tx: Tx | undefined;
  let ready: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  running = clientDb
    .transaction(async (t) => {
      tx = t;
      setAmbientTx(t);
      ready?.();
      await gate;
      throw new RollbackSignal();
    })
    .catch((err: unknown) => {
      if (!(err instanceof RollbackSignal)) throw err;
    });
  await started;

  // The plant ticks are the recorded AAPL poll, so the clock sits at that poll's capture instant;
  // the seeded universe's own validity windows all open in January 2026 and the §16 partitions
  // cover 2026-09, so the same instant serves both halves.
  const clock = testClock(GOLDEN_CAPTURE_MS);
    // `PARITY_DEBUG=1` also turns the server's own logger on at `error`, which is the only way to see
  // the *cause* of a resolver's `500 INTERNAL`: the route reports `"YAS failed."` on the wire and
  // keeps the `RangeError` behind it in the log line.
  const app = await createTestApp({
    db: tx as unknown as Tx,
    clock,
    ...(DEBUG ? { logger: { level: 'error' } } : {}),
  });

  // The seeded PM: `entitlement_grants` gives user 1 and firm 1 `usage_display`, `usage_export`
  // and `usage_api` at `delayed`. The export leg needs `usage_export` (a denied field fails the
  // whole file, API.md §9), and the `delayed` cap is deliberate — it is what makes the downgrade
  // path part of the comparison rather than a case nobody exercises.
  const token = `parity-${randomUUID()}`;
  await client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES (1, $1, 'web', now() + interval '1 day', true)`,
    [createHash('sha256').update(token, 'utf8').digest()],
  );

  const horizon = await client.query<{ valid_at: string; known_at: string }>(
    `SELECT (greatest(
               (SELECT max(valid_from) FROM instruments WHERE tx_to = 'infinity'),
               (SELECT max(valid_from) FROM issues      WHERE tx_to = 'infinity'),
               (SELECT max(valid_from) FROM md_lines    WHERE tx_to = 'infinity')
             ) + interval '1 second') AS valid_at,
            (clock_timestamp() + interval '1 second')                            AS known_at`,
  );
  const horizonRow = horizon.rows[0];
  if (horizonRow === undefined) throw new Error('the seeded database reports no bitemporal horizon');

  const address = await app.app.listen({ host: '127.0.0.1', port: 0 });
  const port = new URL(address).port;

  h = {
    tx: tx as unknown as Tx,
    asOf: {
      validAt: new Date(horizonRow.valid_at).toISOString(),
      knownAt: new Date(horizonRow.known_at).toISOString(),
    },
    client,
    app,
    clock,
    plant: app.deps.plant,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    wsUrl: `ws://127.0.0.1:${port}/ws/v1`,
  };
}

async function close(): Promise<void> {
  if (h !== undefined) {
    await h.app.app.wsGateway.close();
    await h.app.app.close();
  }
  setAmbientTx(undefined);
  release?.();
  release = undefined;
  await running;
  running = undefined;
  h?.client.release();
  await pool?.end();
  h = undefined;
  pool = undefined;
}

function harness(): Harness {
  if (h === undefined) throw new Error('parity harness is not open');
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reading the seeded universe
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SeededSecurity {
  instrumentId: number;
  ticker: string;
  assetClass: string;
}

const SECURITIES = new Map<string, SeededSecurity | null>();

async function loadSecurities(client: pg.PoolClient): Promise<void> {
  for (const [assetClass, spec] of Object.entries(SECURITY_BY_CLASS)) {
    const res =
      'ticker' in spec
        ? await client.query<{ instrument_id: string; ticker: string; asset_class: string }>(
            `SELECT instrument_id, ticker, asset_class FROM instruments
             WHERE tx_to = 'infinity' AND ticker = $1 AND asset_class = $2
             ORDER BY instrument_id LIMIT 1`,
            [spec.ticker, assetClass],
          )
        : await client.query<{ instrument_id: string; ticker: string; asset_class: string }>(
            `SELECT instrument_id, ticker, asset_class FROM instruments
             WHERE tx_to = 'infinity' AND asset_class = $1
             ORDER BY instrument_id LIMIT 1`,
            [spec.anyOfClass],
          );
    const row = res.rows[0];
    SECURITIES.set(
      assetClass,
      row === undefined
        ? null
        : {
            instrumentId: Number(row.instrument_id),
            ticker: row.ticker,
            assetClass: row.asset_class,
          },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The three doors
// ─────────────────────────────────────────────────────────────────────────────────────────────

const API = '/api/v1';

function headers(): Record<string, string> {
  return { cookie: harness().cookie, 'x-requested-with': 'terminal' };
}

interface PayloadEnvelope {
  data: unknown;
  meta: {
    resultId: string;
    traceId: string;
    asOf: { validAt: string; knownAt: string };
    tier: string;
    staleness: string;
    provenance: { provenanceId: number; sourceId: string; attribution: string }[];
    entitlement: { fieldId: string; decision: string; reason: string }[];
    unavailable: { field: string; reason: string }[];
    engines: { name: string; version: string }[];
  };
}

type LaunchOutcome =
  | { ok: true; payload: PayloadEnvelope }
  | { ok: false; status: number; code: string };

/** Door 1 — the JSON payload the screen renders. */
async function launch(c: ParityCase): Promise<LaunchOutcome> {
  const security =
    c.assetClass === null ? undefined : (SECURITIES.get(c.assetClass) ?? undefined);
  const res = await harness().app.app.inject({
    method: 'POST',
    url: `${API}/functions/${c.code}/run`,
    headers: headers(),
    payload: {
      ...(security == null ? {} : { security: { id: security.instrumentId } }),
      params: {},
      asOf: harness().asOf,
      launchKind: 'launch',
      panelId: 'p1',
    },
  });
  if (res.statusCode !== 200) {
    const body = res.json<{ error?: { code?: string } }>();
    if (DEBUG) console.error(`launch ${c.name} → ${String(res.statusCode)} ${res.body}`);
    return { ok: false, status: res.statusCode, code: body.error?.code ?? `HTTP_${res.statusCode}` };
  }
  return { ok: true, payload: res.json<PayloadEnvelope>() };
}

/** Door 2 — the file, for the `resultId` door 1 just produced. */
async function exportCsv(
  code: string,
  resultId: string,
): Promise<{ ok: true; text: string } | { ok: false; status: number; code: string }> {
  const res = await harness().app.app.inject({
    method: 'GET',
    url: `${API}/functions/${code}/csv?resultId=${encodeURIComponent(resultId)}`,
    headers: headers(),
  });
  if (res.statusCode !== 200) {
    const body = res.json<{ error?: { code?: string } }>();
    if (DEBUG) console.error(`export ${code} → ${String(res.statusCode)} ${res.body.slice(0, 400)}`);
    return { ok: false, status: res.statusCode, code: body.error?.code ?? `HTTP_${res.statusCode}` };
  }
  return { ok: true, text: res.body };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV reading — RFC 4180, because the assertion is about cells and not about bytes
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ParsedCsv {
  /** The `#` block, `#` and one following space stripped. */
  comments: string[];
  /** The column-id header row. */
  header: string[];
  /** The data rows. */
  rows: string[][];
}

/**
 * Parse `writeCsv`'s output back into cells.
 *
 * Written here rather than reached for from a library on purpose: the reader has to be an
 * *independent* implementation of RFC 4180 for the comparison to mean anything. If the export were
 * parsed by the same code that wrote it, a quoting bug would cancel out and the test would pass on
 * a file no spreadsheet could open.
 */
function parseCsv(text: string): ParsedCsv {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      throw new Error('bare LF in a CSV export: API.md §9 requires CRLF record ends');
    }
    cell += ch;
    i += 1;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    records.push(row);
  }

  const comments: string[] = [];
  let at = 0;
  while (at < records.length && (records[at]![0] ?? '').startsWith('#')) {
    comments.push(records[at]!.join(',').replace(/^#\s?/, ''));
    at += 1;
  }
  return {
    comments,
    header: records[at] ?? [],
    rows: records.slice(at + 1),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The payload's own values
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every rendering of every leaf the payload, its envelope and its column list contain.
 *
 * A CSV cell is allowed to be any of these and nothing else. The set is widened in exactly three
 * controlled ways, each of which a real export legitimately needs:
 *
 *  - a number contributes its shortest round-trip decimal (`numberToCsv`, the exporter's own rule),
 *  - an epoch-looking integer additionally contributes `YYYY-MM-DD` and ISO-UTC, because a `date`
 *    or `datetime` column renders an epoch that way,
 *  - the column ids and labels are allowed, because a multi-block screen puts a block name in a
 *    leading `section` column and a transposed screen puts a field label in a row.
 *
 * Nothing else. A thousands separator, a currency symbol, a percent sign, an em dash, a value
 * rounded to two places and a re-ordered date are all absent from the set, which is the whole point.
 */
function renderings(value: unknown, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    into.add(value);
    return;
  }
  if (typeof value === 'boolean') {
    into.add(value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return;
    into.add(numberToCsv(value));
    // An epoch a `date`/`datetime` column would render. The floor is 1e11 ms (1973), below which a
    // number is far likelier to be a price, a quantity or a basis-point move than an instant.
    if (Number.isInteger(value) && Math.abs(value) >= 1e11) {
      into.add(isoDateFromEpochMs(value));
      into.add(isoDateTimeFromEpochMs(value));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) renderings(item, into);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) renderings(item, into);
    // A key is a value on a transposed screen (`W`'s field rows, `FA`'s line items).
    for (const key of Object.keys(value)) into.add(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live cells — the WS leg's own index
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface LiveRef {
  subject: string;
  field: FieldId;
  cell: ValueCell;
}

/** Every `ValueCell` in a payload that names a live (subject, field). */
function liveCells(value: unknown, out: LiveRef[]): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) liveCells(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  const live = record.live;
  const v = record.v;
  // A `ValueCell` and nothing else: `st` is required on the type, `v` is a scalar, and `provIdx` is
  // a number. Matching on `live` alone was not enough — `GP`'s series block carries a `live` hint
  // beside an *array* of closes, and treating that as a cell compared 250 volumes with one quote.
  if (
    live !== null &&
    typeof live === 'object' &&
    typeof (live as { subject?: unknown }).subject === 'string' &&
    typeof (live as { field?: unknown }).field === 'string' &&
    typeof record.st === 'string' &&
    typeof record.provIdx === 'number' &&
    (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
  ) {
    const ref = live as { subject: string; field: FieldId };
    out.push({ subject: ref.subject, field: ref.field, cell: record as unknown as ValueCell });
  }
  for (const item of Object.values(record)) liveCells(item, out);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Plant state — one recorded tick per subject, so both doors read the SAME source
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface NormalisedFixture {
  updates: NormalisedUpdate[];
}

/**
 * How far the clock moves between cases: one minute, which is `3600 s / 60` — the smallest step at
 * which API.md §8's "60 exports per hour" sliding window can carry eighty of them.
 */
const EXPORT_WINDOW_MS = 61_000;

/** The one recorded quote observation (`cboe-quote-AAPL`), as WP-05 normalises it. */
let goldenTick: NormalisedUpdate | undefined;

async function golden(): Promise<NormalisedUpdate> {
  if (goldenTick === undefined) {
    const fx = await readNormalised<NormalisedFixture>('cboe-quote-AAPL');
    goldenTick = fx.updates[0]!;
  }
  return goldenTick;
}

/**
 * Publish the recorded poll into the plant for every `cboe.quotes` line the seed holds for the case
 * securities and the seeded watchlists' members.
 *
 * This is what makes the WS leg a *parity* assertion rather than two independent readings: the
 * resolver reads its live cells from this plant through `functions/context.ts#plantReader`, and the
 * gateway projects its `snap` from the same plant. One source, two doors. Publishing nothing would
 * leave both sides blank and the comparison vacuously true — which is the failure this whole file
 * exists to make impossible.
 *
 * The fixture is a single poll (one `seqno`), so every subject gets the same field values re-keyed
 * onto its own ids. That is legitimate — nothing here asserts that two instruments trade at
 * different prices — and it is the only quote observation on disk (FEED-08: a fixture miss throws).
 */
async function plantTicks(client: pg.PoolClient, plant: Plant): Promise<number> {
  const base = await golden();
  const ids = [...SECURITIES.values()].flatMap((s) => (s === null ? [] : [s.instrumentId]));
  const members = await client.query<{ instrument_id: string }>(
    `SELECT DISTINCT instrument_id FROM watchlist_items ORDER BY instrument_id`,
  );
  for (const row of members.rows) ids.push(Number(row.instrument_id));

  const lines = await client.query<{ instrument_id: string; md_line_id: string; provenance_id: string }>(
    `SELECT instrument_id, md_line_id, provenance_id FROM md_lines
     WHERE tx_to = 'infinity' AND source_id = 'cboe.quotes' AND instrument_id = ANY($1::bigint[])`,
    [[...new Set(ids)]],
  );

  for (const line of lines.rows) {
    const instrumentId = Number(line.instrument_id);
    const subject = `q:${String(instrumentId)}`;
    const update: NormalisedUpdate = {
      ...base,
      subject,
      instrumentId,
      mdLineId: Number(line.md_line_id),
      fields: { ...base.fields },
      ts: { src: base.ts.src, cap: base.ts.cap, pub: 0 },
      prov: { ...base.prov, provenanceId: Number(line.provenance_id) },
    };
    plant.apply(update);
    PLANTED.set(subject, update);
  }
  return lines.rowCount ?? 0;
}

/** The subjects {@link plantTicks} published, with the update each one was published from. */
const PLANTED = new Map<string, NormalisedUpdate>();

/**
 * Observe every planted subject again at the current instant.
 *
 * The update carries the same `srcSeq` it was first applied with, so `plant.apply` takes its
 * replayed-sequence branch: `ts.cap` moves to the new capture instant and `ageMs` returns to zero
 * while every field, every `fieldTs` and the provenance stay exactly as recorded. That is what a
 * poll of an unchanged quote *is* — and `cboe-quote-AAPL` is one poll, so it is also the only
 * follow-on observation this file is entitled to (FEED-08: no fixture, no data).
 */
async function repoll(plant: Plant): Promise<void> {
  const base = await golden();
  const now = harness().clock.now();
  for (const [, update] of PLANTED) {
    plant.apply({ ...update, fields: { ...base.fields }, ts: { ...update.ts, cap: now, pub: 0 } });
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A socket
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Snapshot {
  seq: number;
  tier: string;
  reason?: string;
  f: Record<string, unknown>;
  st: string;
  r?: Record<string, string>;
  prov: { p: string; id: number; seq?: number };
}

/**
 * `sub` to `subjects` over a real socket and collect the `snap` of each.
 *
 * A real socket rather than the session object in-process, because the mask, the tier downgrade and
 * the blank `snap` are all decided on the way out of the gateway and a test that called the session
 * directly would not see them (API.md §6.4/§6.6).
 */
async function snapshots(
  subjects: readonly { subject: string; fields: readonly FieldId[] }[],
): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  if (subjects.length === 0) return out;

  const socket = new WebSocket(harness().wsUrl, { headers: { cookie: harness().cookie } });
  const frames: ServerMsg[] = [];
  const record = (frame: ServerMsg): void => {
    frames.push(frame);
    if (frame.t === 'batch') for (const member of frame.m) frames.push(member);
  };
  socket.on('message', (data: unknown) => {
    record(JSON.parse(String(data)) as ServerMsg);
  });
  socket.on('error', () => undefined);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', (err: Error) => {
        reject(err);
      });
      socket.once('close', (code: number) => {
        reject(new Error(`socket closed before open: ${String(code)}`));
      });
    });

    socket.send(JSON.stringify({ t: 'hello', protocol: 1, client: 'parity/0.1.0' }));
    await waitFor(frames, (f) => f.t === 'welcome' || f.t === 'error');

    socket.send(
      JSON.stringify({
        t: 'sub',
        id: 1,
        subjects: subjects.map((s) => ({ s: s.subject, f: [...s.fields] })),
      }),
    );
    await waitFor(frames, (f) => f.t === 'subAck');
    // The snapshot burst follows the ack inside `batch` frames; one `snap` per accepted subject.
    await waitFor(
      frames,
      () => frames.filter((f) => f.t === 'snap').length >= countAccepted(frames),
      2_000,
    );

    for (const frame of frames) {
      if (frame.t !== 'snap') continue;
      const snap = frame as unknown as Snapshot & { s: string };
      out.set(snap.s, snap);
    }
    return out;
  } finally {
    socket.close(1000, 'parity over');
  }
}

/** How many subjects the gateway accepted, from the `subAck` it sent. */
function countAccepted(frames: readonly ServerMsg[]): number {
  const ack = frames.find((f) => f.t === 'subAck');
  if (ack === undefined) return 0;
  return (ack as unknown as { accepted: readonly unknown[] }).accepted.length;
}

/** Resolve once `predicate` holds over the frames received so far. Polls; the socket is real. */
async function waitFor(
  frames: readonly ServerMsg[],
  predicate: (f: ServerMsg) => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (frames.some(predicate)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for a frame; received: ${frames.map((f) => f.t).join(',')}`,
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run: one launch per case, all three doors, collected up front
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Observed {
  outcome: LaunchOutcome;
  csv?: { ok: true; text: string } | { ok: false; status: number; code: string };
  live: LiveRef[];
  /** The `snap` of every live subject of THIS case, taken at the same clock instant as its launch. */
  snaps: Map<string, Snapshot>;
}

const OBSERVED = new Map<string, Observed>();

beforeAll(async () => {
  // Reachability, migrations and the seed, each reported separately: "the parity suite cannot run"
  // is only useful with the reason attached.
  let probe: pg.Pool | undefined;
  try {
    probe = new Pool({ connectionString: SEED_DATABASE_URL, max: 1 });
    const count = await probe.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM instruments WHERE tx_to = 'infinity'`,
    );
    const n = Number(count.rows[0]?.n ?? '0');
    PRECONDITIONS.push({
      ok: n >= MIN_SEEDED_INSTRUMENTS,
      detail:
        `${SEED_DATABASE_URL} holds ${String(n)} current instruments ` +
        `(need ≥ ${String(MIN_SEEDED_INSTRUMENTS)})`,
    });
  } catch (err) {
    PRECONDITIONS.push({
      ok: false,
      detail: `${SEED_DATABASE_URL} is not a migrated, seeded database: ${String(err)}`,
    });
  } finally {
    await probe?.end();
  }

  if (!PRECONDITIONS.every((p) => p.ok)) return;

  await open();
  const harnessed = harness();
  await loadSecurities(harnessed.client);
  const planted = await plantTicks(harnessed.client, harnessed.plant);
  PRECONDITIONS.push({
    ok: planted > 0,
    detail: `${String(planted)} cboe.quotes md_lines received the recorded poll`,
  });
  // All three doors, case by case, here rather than inside each test: the census has to see every
  // outcome before the first assertion runs, the export must read the `resultId` of the run that
  // produced it, and — the part that matters most — the socket has to be read at the SAME clock
  // instant as the launch. Staleness is measured against the clock, so a snapshot taken after the
  // whole matrix had advanced the clock would legitimately disagree with the payload about `st` and
  // the comparison would have to look away from exactly the field it exists to check.
  for (const c of CASES) {
    // API.md §8 gives the export routes "2 req/s, 60 per hour", on the injected clock. Eighty
    // launches and sixty-odd exports inside one frozen instant spend that hour's allowance and
    // every case after the sixtieth answers `429 RATE_LIMITED` — observed, not feared. One minute
    // of virtual time per case slides the hour window instead, which is also what a terminal
    // launching eighty screens actually does. No limit is relaxed to make this pass; resetting the
    // limiter would be the version of this fix that stops testing the shipped wiring.
    harnessed.clock.advance(EXPORT_WINDOW_MS);
    // Re-poll every planted subject at the new instant. `plant.apply` treats a repeated `srcSeq` as
    // a replayed sequence and moves `ts.cap` forward without touching a single value (FEED-05), so
    // this is the recorded poll observed again and not a tick this file invented — there is exactly
    // one quote observation on disk and no second one may be derived from it (WORKPLAN WP-15).
    await repoll(harnessed.plant);

    const outcome = await launch(c);
    const observed: Observed = { outcome, live: [], snaps: new Map() };
    if (outcome.ok) {
      observed.csv = await exportCsv(c.code, outcome.payload.meta.resultId);
      liveCells(outcome.payload.data, observed.live);

      // Every distinct (subject, field) this payload names and the plant can answer for. The
      // gateway's mask is per-subject, so the union of a subject's fields is what one screen asks.
      const wanted = new Map<string, Set<FieldId>>();
      for (const ref of observed.live) {
        if (harnessed.plant.get(ref.subject) === undefined) continue;
        let fields = wanted.get(ref.subject);
        if (fields === undefined) {
          fields = new Set<FieldId>();
          wanted.set(ref.subject, fields);
        }
        fields.add(ref.field);
      }
      observed.snaps = await snapshots(
        [...wanted].map(([subject, fields]) => ({ subject, fields: [...fields] })),
      );
    }
    OBSERVED.set(c.name, observed);
  }

}, 600_000);

afterAll(async () => {
  await close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The assertions
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('API-05 — the same number whichever door it comes out of', () => {
  it('has a seeded database to run against', () => {
    const failed = PRECONDITIONS.filter((p) => !p.ok);
    expect(
      failed.map((p) => p.detail),
      'API-05 parity CANNOT RUN. The acceptance row is "every manifest × seed securities", so a ' +
        'run without the DATA_MODEL §18 universe proves nothing and this file will not report ' +
        'green for it. Produce the database with:\n' +
        `    DATABASE_URL=${SEED_DATABASE_URL} npm run db:migrate\n` +
        '    npx vitest run --project server-seed\n' +
        'or point DATABASE_URL_SEED_TEST at a database that already has it.',
    ).toEqual([]);
  });

  it('covers every manifest in the generated catalogue', () => {
    // A manifest with no case at all would be silently exempt from API-05, which is the one way
    // this file could report green over a function nobody compared.
    const covered = new Set(CASES.map((c) => c.code));
    expect([...Object.keys(manifests)].filter((code) => !covered.has(code))).toEqual([]);
    expect(covered.size).toBe(Object.keys(manifests).length);
  });

  it('launched every manifest × seeded asset class the census records', () => {
    const actual: Record<string, string> = {};
    for (const c of CASES) {
      const observed = OBSERVED.get(c.name);
      if (observed === undefined) continue;
      actual[c.name] = observed.outcome.ok ? 'ok' : observed.outcome.code;
    }
    expect(actual).toEqual(CENSUS);
  });

  it('exported every payload the census records an export for', () => {
    const actual: Record<string, string> = {};
    for (const c of CASES) {
      const observed = OBSERVED.get(c.name);
      if (!observed?.outcome.ok) continue;
      const csv = observed.csv;
      actual[c.name] = csv === undefined ? 'not-attempted' : csv.ok ? 'ok' : csv.code;
    }
    expect(actual).toEqual(CSV_CENSUS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 1 ⇄ Door 2 — the file and the screen
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A cell that is *trying to be a number*: digits, optionally with a currency symbol, a thousands
 * separator, a percent, a parenthesised negative or surrounding whitespace, and nothing else.
 *
 * This is the test applied to `string` columns, and the shape of it is the point. A string column
 * legitimately carries prose, an enum name, a pipe-joined list of SEC item numbers, a headline with
 * an em dash in it — none of which a rule about numbers should have an opinion on. What it may not
 * carry is a *measurement that has been formatted*, because FUNCTIONS.md §1.6 rule 2 says an export
 * holds full stored precision and a spreadsheet cannot read `1,234.57` as a number. So the rule
 * fires only when the whole cell is numeric-looking, and then demands the plain form.
 */
const NUMERIC_LOOKING = /^\s*[-(+]?[$€£¥]?\s*\d[\d,]*(?:\.\d+)?\s*\)?\s*%?\s*$/u;

/**
 * A cell that is nothing but a "no value" marker.
 *
 * `serialiseCell` renders a `null` as the empty string and API.md §9 requires exactly that: a CSV is
 * read by software, and an em dash in a numeric column is a parse error where an empty field is a
 * blank. A dash *inside* text is not this — `"4 — FORM 4"` is a headline — so the match is anchored
 * to the whole cell.
 *
 * `na` is deliberately absent. It looks like a placeholder and is not: `'na'` is a member of
 * `ValueState` (core/types/quote.ts), so `Q`'s and `W`'s `state` column carrying it is the payload's
 * own value. Listing it flagged six working cells across `Q`, `W` and `WEI` before that was noticed.
 */
const NULL_PLACEHOLDER = /^\s*(?:[-–—]+|n\/a|#n\/a|null|undefined|nan|\?+)\s*$/iu;

/** Full-precision decimal, the only numeric text `serialiseCell` emits. */
const PLAIN_NUMBER = /^-?(?:\d+(?:\.\d+)?|\d+(?:\.\d+)?[eE][-+]?\d+)$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/**
 * Cell violations this file has found that belong to another package's file, recorded verbatim.
 *
 * This is **not** a tolerance and it is not a place to put a cell one cannot explain. It is a list
 * of defects with an owner, kept here because WP-15 may not edit the files that hold them and
 * because a suite that fails on a known, reported defect stops being read. Each entry is asserted
 * exactly, so the list fails in both directions: a new violation is a new defect, and a violation
 * that disappears means the fix landed and the entry must go.
 *
 * `FA×equity` — `core/src/functions/manifests/FA.ts` declares every period column `type: 'number'`
 * (the column ids are period-end dates), and its own `rows` then put the filing date and the SEC
 * accession number of each period into those columns as text. A spreadsheet reading the column as
 * numeric gets `#VALUE!` on two of fifteen rows. The fix is in the manifest — either the two footer
 * rows move out of the table (FUNCTIONS.md §1.6 rule 3 allows a leading `section` column) or the
 * columns are typed `string` — and it is not this file's to make.
 */
const KNOWN_CELL_DEFECTS: Record<string, readonly string[]> = {
  'FA×equity': [
    'row 13 col 2025-09-27 (number): not a full-precision decimal: "2025-10-31"',
    'row 13 col 2024-09-28 (number): not a full-precision decimal: "2025-10-31"',
    'row 13 col 2023-09-30 (number): not a full-precision decimal: "2025-10-31"',
    'row 13 col 2022-09-24 (number): not a full-precision decimal: "2024-11-01"',
    'row 13 col 2021-09-25 (number): not a full-precision decimal: "2023-11-03"',
    'row 13 col 2020-09-26 (number): not a full-precision decimal: "2022-10-28"',
    'row 13 col 2019-09-28 (number): not a full-precision decimal: "2021-10-29"',
    'row 13 col 2018-09-29 (number): not a full-precision decimal: "2020-10-30"',
    'row 14 col 2025-09-27 (number): not a full-precision decimal: "0000320193-25-000079"',
    'row 14 col 2024-09-28 (number): not a full-precision decimal: "0000320193-25-000079"',
    'row 14 col 2023-09-30 (number): not a full-precision decimal: "0000320193-25-000079"',
    'row 14 col 2022-09-24 (number): not a full-precision decimal: "0000320193-24-000123"',
    'row 14 col 2021-09-25 (number): not a full-precision decimal: "0000320193-23-000106"',
    'row 14 col 2020-09-26 (number): not a full-precision decimal: "0000320193-22-000108"',
    'row 14 col 2019-09-28 (number): not a full-precision decimal: "0000320193-21-000105"',
    'row 14 col 2018-09-29 (number): not a full-precision decimal: "0000320193-20-000096"',
  ],
};

/**
 * One `# key: value` line of the standard header block, with the key removed and nothing trimmed.
 *
 * Untrimmed on purpose. `standardHeaderLines` packs three fields onto the provenance line separated
 * by two spaces (`provenance: 1,2  engines: stats/1.0.0  trace: …`), so the value of the first field
 * is everything up to the first double space. Trimming first makes an *empty* provenance list read
 * as `engines: …` — which is what `HELP`, `MSG` and `Q×rate` reported before this was fixed, and a
 * comparison that reads the wrong field is worse than one that is missing.
 */
function comment(parsed: ParsedCsv, key: string): string | undefined {
  const line = parsed.comments.find((c) => c.startsWith(`${key}:`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

/** The first field of a header line that packs several, split at the documented double space. */
function firstField(value: string | undefined): string | undefined {
  return value === undefined ? undefined : (value.split('  ')[0] ?? '').trim();
}

describe.each(CASES.map((c) => [c.name, c] as const))(
  'API-05 %s',
  (_name, c) => {
    /** The case's three doors, or the census code that says why there are fewer than three. */
    function observed(): Observed {
      const found = OBSERVED.get(c.name);
      if (found === undefined) throw new Error(`no observation for ${c.name}`);
      return found;
    }

    it('JSON payload = CSV export, value by value', () => {
      const o = observed();
      if (!o.outcome.ok) {
        // The census test is what asserts *which* cases do not launch; here it only keeps this test
        // from claiming a comparison it did not make.
        expect(CENSUS[c.name]).toBe(o.outcome.code);
        return;
      }
      const csv = o.csv;
      expect(csv, `${c.name}: no export was fetched`).toBeDefined();
      if (!csv?.ok) {
        // Which exports are refused is the previous test's business; here this only keeps the case
        // from reporting a comparison it could not make.
        expect(CSV_CENSUS[c.name]).toBe(csv === undefined ? 'not-attempted' : csv.code);
        return;
      }

      const manifest = generatedRegistry.get(c.code);
      if (manifest === undefined) throw new Error(`no manifest for ${c.code}`);
      const payload = o.outcome.payload;
      const parsed = parseCsv(csv.text);

      // The column list is the manifest's own, evaluated over this payload — so the header row of
      // the file is asserted to BE the screen's column list rather than merely to look like one.
      const params = manifest.params.parse({}) as unknown;
      const spec = manifest.csv.columns;
      const columns =
        typeof spec === 'function'
          ? (spec as (p: unknown, d: unknown) => readonly { id: string; label: string; type: string }[])(
              params,
              payload.data,
            )
          : (spec as readonly { id: string; label: string; type: string }[]);
      expect(parsed.header, `${c.name}: the export's header row is not the manifest's columns`).toEqual(
        columns.map((col) => col.id),
      );

      // Every rendering of every value the payload, its envelope, its params and its column list
      // hold. A cell outside this set was produced by the export path and by nothing else.
      const allowed = new Set<string>();
      renderings(payload.data, allowed);
      renderings(payload.meta, allowed);
      renderings(params, allowed);
      for (const col of columns) {
        allowed.add(col.id);
        allowed.add(col.label);
      }

      const violations: string[] = [];
      for (const [r, row] of parsed.rows.entries()) {
        expect(row.length, `${c.name}: CSV row ${String(r)} is ${String(row.length)} cells wide`).toBe(
          columns.length,
        );
        for (const [i, cell] of row.entries()) {
          const col = columns[i]!;
          const where = `row ${String(r)} col ${col.id} (${col.type})`;
          if (cell === '') continue;
          if (NULL_PLACEHOLDER.test(cell)) {
            violations.push(`${where}: a null rendered as ${JSON.stringify(cell)}, not as an empty field`);
            continue;
          }

          // A `string` column is prose, an enum, an identifier or a joined list, and the CSV spec is
          // entitled to build one out of the payload's structure (`'4WK|discount_rate'`,
          // `'Technology|Meta Platforms Inc'`, a field label, a block name). So it is held to the
          // one rule that is about data rather than presentation: if it looks like a number, it has
          // to be the payload's number, at full precision.
          if (col.type === 'string') {
            if (NUMERIC_LOOKING.test(cell) && !(PLAIN_NUMBER.test(cell) && allowed.has(cell))) {
              violations.push(`${where}: a formatted number in an export: ${JSON.stringify(cell)}`);
            }
            continue;
          }

          // Everything else is a measurement or an instant, and both the shape and the value are
          // asserted. This is where the defects live that no single-door test can see: a rounding
          // done in the writer, a separator added for the screen, a date re-ordered, a boolean
          // rendered as `Yes`.
          if (col.type === 'number' && !PLAIN_NUMBER.test(cell)) {
            violations.push(`${where}: not a full-precision decimal: ${JSON.stringify(cell)}`);
            continue;
          }
          if (col.type === 'date' && !ISO_DATE.test(cell)) {
            violations.push(`${where}: not YYYY-MM-DD: ${JSON.stringify(cell)}`);
            continue;
          }
          if (col.type === 'datetime' && !ISO_DATETIME.test(cell)) {
            violations.push(`${where}: not an ISO-UTC instant: ${JSON.stringify(cell)}`);
            continue;
          }
          if (col.type === 'boolean' && cell !== 'true' && cell !== 'false') {
            violations.push(`${where}: not a boolean: ${JSON.stringify(cell)}`);
            continue;
          }
          if (!allowed.has(cell)) {
            violations.push(`${where}: ${JSON.stringify(cell)} is in no payload value`);
          }
        }
      }
      if (DEBUG && violations.length > 0) console.error(`### ${c.name}\n${violations.join('\n')}`);
      expect(
        violations,
        `${c.name}: the export's cells are not the payload's own values (API-05, FUNCTIONS.md §1.6)`,
      ).toEqual(KNOWN_CELL_DEFECTS[c.name] ?? []);
    });

    it('the export header block repeats the payload envelope exactly', () => {
      const o = observed();
      if (!o.outcome.ok) return;
      const csv = o.csv;
      if (!csv?.ok) return;
      const parsed = parseCsv(csv.text);
      const meta = o.outcome.payload.meta;

      // DATA-10: the provenance indices, in order. `meta.provenance[i]` is what a payload's
      // `provIdx` points at, so a file whose list is re-ordered or de-duplicated makes every
      // `provIdx` in the screen's own JSON name the wrong source.
      expect(firstField(comment(parsed, 'provenance')), `${c.name}: provenance`).toBe(
        meta.provenance.map((p) => p.provenanceId).join(','),
      );
      expect(comment(parsed, 'asOf')?.trim(), `${c.name}: asOf/tier/staleness`).toBe(
        `validAt=${meta.asOf.validAt} knownAt=${meta.asOf.knownAt}  tier: ${meta.tier}  ` +
          `staleness: ${meta.staleness}`,
      );
      // DATA-01: the licence footer is not optional, and it is the attribution of the sources the
      // payload itself cites — not a constant, and not a superset.
      // Deduplicated and in first-citation order, which is what `export.ts#attributionsOf` produces
      // and what DATA-01 means by "the licence line": one attribution per cited source, not one per
      // citation, and never an empty `;` separator for a source whose licence carries no line.
      expect(comment(parsed, 'source')?.trim(), `${c.name}: attribution`).toBe(
        [...new Set(meta.provenance.map((p) => p.attribution).filter((a) => a !== ''))].join('; '),
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Door 1 ⇄ Door 3 — the screen and the socket
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How many (cell, subject, field) triples the WS leg compared on the run this file was committed
 * from.
 *
 * Asserted exactly, because every interesting way this leg could stop working makes it *quieter*
 * rather than red: a resolver that stops emitting `ValueCell.live`, a plant that holds no state, a
 * `sub` the gateway rejects, a `snap` that never arrives. Each of those leaves the loop below with
 * nothing to compare and nothing to say. A number here turns all four into a failure.
 */
const LIVE_COMPARISONS = 270;

/**
 * How many of those 270 carry a **value** on the payload side, and therefore actually reach the
 * value-equality assertion.
 *
 * This number is the one that keeps the leg honest, and it is here because the first mutation test
 * of this file could not kill its own value comparison: shifting `policyTier.ts#identityView` by
 * 0.01 left every assertion green, because both doors project through that same function and the
 * shift moved both. The asymmetric mutation — `functions/context.ts#plantReader`, which only the
 * function path uses — produced 182 mismatches, which is exactly this count. So a run where the
 * payload's live cells are all blank placeholders would compare 270 things and assert nothing about
 * a single number, and would look identical to a healthy one without this line.
 */
const LIVE_VALUE_COMPARISONS = 182;

/**
 * The reasons that are a statement about **the subscriber's rights** rather than about which tier
 * this screen chose to read at.
 *
 * The distinction decides what parity even means for a blank cell, so it is worth being exact about.
 * A cell blanked for one of these has been refused to *this user*, and refusing it on the payload
 * and serving it on the socket a second later would be an entitlement bypass with a UI in front of
 * it — the defect this pairing exists to catch (ENTL-05, ARCHITECTURE §10 rule 2).
 *
 * `TIER_EOD` is deliberately **not** in the list. A screen may ask the plant gate for `eod` on
 * purpose — `HDS`, `EQS` and `CACS` all do, to avoid charging a realtime read for a fifty-row grid
 * — and the gate then blanks every field it has no official close for. The shell fills those cells
 * from the WS cache at whatever tier the user's own grant allows, which is exactly what
 * `ValueCell.live` is for (core/types/function.ts L108). Treating that as a mismatch made this test
 * fail 126 times over working behaviour, which is how the distinction was found.
 */
/**
 * Live-cell disagreements that belong to another package, recorded verbatim for the same reason
 * {@link KNOWN_CELL_DEFECTS} is, and asserted exactly so the list fails in both directions.
 *
 * `Q×index` is the finding this whole leg was written to be able to make. The seeded `field_licence`
 * table has rows for `(BID_SIZE, equity)`, `(BID_SIZE, etf)` and `(BID_SIZE, option)` and none for
 * `(BID_SIZE, index)` — so the evaluator answers `FIELD_UNKNOWN` (a *denial*) when the function
 * runner asks about SPX, and `Q`'s payload blanks both size cells. The WebSocket gateway, asked
 * about the same user, the same subject and the same two fields, sends 40 and 120 with no reason at
 * all. One door refuses the value and the other serves it: an entitlement decision that depends on
 * which door you knock at (ENTL-05, ARCHITECTURE §10 rule 2, API.md §6.6).
 *
 * The fix is one of two, and neither is WP-15's to make: `seed/licences.ts` gains the missing
 * `field_licence` rows for the index asset class, or `ws/session.ts` applies the evaluator's
 * per-field denials to the mask the way `functions/runner.ts` does. Until then the pair is recorded
 * here, named, so it is neither hidden nor able to hide the next one.
 */
const KNOWN_LIVE_DEFECTS: readonly string[] = [
  'Q×index q:37367.BID_SIZE: the payload refuses this for FIELD_UNKNOWN and the snapshot sends 40',
  'Q×index q:37367.BID_SIZE: blank reason: payload "FIELD_UNKNOWN" ≠ snapshot undefined',
  'Q×index q:37367.ASK_SIZE: the payload refuses this for FIELD_UNKNOWN and the snapshot sends 120',
  'Q×index q:37367.ASK_SIZE: blank reason: payload "FIELD_UNKNOWN" ≠ snapshot undefined',
];

const DENIAL_REASONS = new Set<string>([
  'NOT_ENTITLED_TIER',
  'NO_FIRM_ENTITLEMENT',
  'NO_USER_ENTITLEMENT',
  'LICENCE_FORBIDS_USAGE',
  'FIELD_UNKNOWN',
  'QUOTA_EXCEEDED',
  'CONCURRENT_SESSION',
  'NOT_IN_UNIVERSE',
]);

describe('API-05 — the screen and the socket', () => {
  it('every live cell holds the value the gateway sends for its subject and field', () => {
    const violations: string[] = [];
    let compared = 0;
    let withValues = 0;

    for (const c of CASES) {
      const o = OBSERVED.get(c.name);
      if (!o?.outcome.ok) continue;
      const provenance = o.outcome.payload.meta.provenance;

      for (const ref of o.live) {
        const snap = o.snaps.get(ref.subject);
        if (snap === undefined) continue;
        const where = `${c.name} ${ref.subject}.${ref.field}`;
        const cell = ref.cell;
        const sent = snap.f[ref.field];
        const snapReason = snap.r?.[ref.field];
        compared += 1;

        // A field the mask did not carry at all. `undefined` is not `null`: a cell whose subject and
        // field the gateway never sends can never be filled, so a screen that drew a placeholder
        // there stays blank for the life of the session (TERM-08).
        if (!(ref.field in snap.f)) {
          violations.push(
            `${where}: the snapshot carries no such field (payload has ${JSON.stringify(cell.v)})`,
          );
          continue;
        }

        if (cell.v !== null) {
          withValues += 1;
          // The assertion this whole file is for: one value, two serialisations.
          if (!Object.is(sent, cell.v)) {
            violations.push(
              `${where}: payload ${JSON.stringify(cell.v)} ≠ snapshot ${JSON.stringify(sent)}`,
            );
          }
          if (snapReason !== undefined) {
            violations.push(
              `${where}: the snapshot blames ${snapReason} for a value the payload has`,
            );
          }
        } else if (cell.r !== undefined && DENIAL_REASONS.has(cell.r)) {
          // The entitlement mask, on both doors or on neither. A field refused to this user on the
          // payload path and served in full over the socket is an entitlement bypass that reads, to
          // the user, as a number appearing out of nowhere a second after the screen drew a blank.
          if (sent !== null) {
            violations.push(
              `${where}: the payload refuses this for ${cell.r} and the snapshot sends ` +
                `${JSON.stringify(sent)}`,
            );
          }
          expectSame(violations, `${where}: blank reason`, cell.r, snapReason);
        }
        // Any other blank — `TIER_EOD`, a staleness reason, or no reason at all — is the documented
        // placeholder a screen draws and the WS cache fills (`ValueCell.live`). The socket carrying
        // a value there is the contract working, so the only thing asserted is the mask above.

        // DATA-10: `provIdx` indexes `meta.provenance`, and the snapshot cites a `provenance_id`
        // directly. They have to name the same row, or the screen's "where did this come from"
        // answer changes the moment the first delta lands.
        const cited = provenance[cell.provIdx];
        if (cited === undefined) {
          violations.push(`${where}: provIdx ${String(cell.provIdx)} is outside meta.provenance`);
        } else if (cited.provenanceId !== snap.prov.id) {
          violations.push(
            `${where}: payload cites provenance ${String(cited.provenanceId)}, ` +
              `snapshot cites ${String(snap.prov.id)}`,
          );
        }
      }
    }

    expect(violations, 'live cells that disagree with their own snapshot').toEqual(
      KNOWN_LIVE_DEFECTS,
    );
    expect(compared, 'live (cell, subject, field) triples compared').toBe(LIVE_COMPARISONS);
    expect(withValues, 'compared triples where the payload carries a value').toBe(
      LIVE_VALUE_COMPARISONS,
    );
  });
});

/** Record a mismatch rather than throwing, so one run reports every disagreement it found. */
function expectSame(
  violations: string[],
  where: string,
  payload: unknown,
  snapshot: unknown,
): void {
  if (payload === snapshot) return;
  violations.push(`${where}: payload ${JSON.stringify(payload)} ≠ snapshot ${JSON.stringify(snapshot)}`);
}
