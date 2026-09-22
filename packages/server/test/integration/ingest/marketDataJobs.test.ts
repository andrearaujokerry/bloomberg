/**
 * The eight market-data ingest jobs of PROVIDERS §13, driven end to end from the recorded captures.
 *
 * WORKPLAN WP-05 asks these jobs to be **idempotent**: "a second run over the same capture writes
 * nothing new". Every assertion below is therefore a *row count* taken from the database before and
 * after a second run, never a boolean returned by the code under test — a job that reported
 * `inserted: 0` while quietly doubling `quote_ticks` would pass a boolean assertion and fail this
 * one.
 *
 * All eight are exercised, one suite each, covering all five write paths:
 *
 *  | job             | source             | capture                       | table |
 *  | --------------- | ------------------ | ----------------------------- | ----- |
 *  | `cboeQuotes`    | `cboe.quotes`      | `cboe-quote-AAPL`, `cboe-vix` | `quote_ticks` — the `NOT EXISTS` guard (no natural key) |
 *  | `cboeEuIndices` | `cboe.euIndices`   | `cboe-eu-indices`             | `quote_ticks` + `identifiers` |
 *  | `cboeOptions`   | `cboe.options`     | `cboe-options`                | `option_quotes` + the minted `instruments`/`identifiers`/`option_terms` |
 *  | `crypto`        | `coingecko.simple` | `coingecko-simple.json`       | `quote_ticks`, one request for every id |
 *  | `yahooIntraday` | `yahoo.chart`      | `yahoo-ftse`                  | `bars_intraday` |
 *  | `fxIntraday`    | `yahoo.chart`      | `yahoo-fx`                    | `bars_intraday` |
 *  | `yahooDaily`    | `yahoo.chart`      | `yahoo-chart-events`          | `bars_daily` + `corporate_actions` |
 *  | `fxEod`         | `frankfurter`      | `frankfurter`                 | `fx_rates` + `bars_daily` |
 *
 * Everything the jobs read is built here, in the test's own rolled-back transaction, through WP-04's
 * repositories: WP-15 owns the seed and it does not exist yet. Nothing reaches the network — the
 * jobs are given a `ReplayStore` and no `HttpClient`, and a capture the store does not hold throws
 * (PROVIDERS.a §3.6) rather than opening a socket.
 *
 * One thing that deliberately *does* grow on a second run: `provenance`. PROVIDERS.a §1.3 requires
 * exactly one row per non-304 exchange, so two polls of the same symbol are two provenance rows
 * over one `quote_ticks` row — "where did this number come from" and "how often did we ask" are
 * different questions. The tests assert both halves.
 *
 * ## Locking, and the sibling fork doing partition DDL
 *
 * Every suite here writes the partitioned market-data tables, and
 * `test/integration/ingest/partitions.test.ts` creates and drops partitions **of those same
 * parents**, committing as it goes. `CREATE TABLE … PARTITION OF` takes `SHARE ROW EXCLUSIVE` on
 * the parent and an `INSERT` takes `ROW EXCLUSIVE`; the two conflict, and the `server-int` project
 * runs four forks concurrently. Left alone, the two files interleave their lock acquisitions and
 * Postgres resolves the pair as a deadlock (`40P01`) rather than a wait — whichever side it picks
 * as the victim.
 *
 * {@link lockMarketTables} removes the cycle from this side: each test takes `ROW EXCLUSIVE` on all
 * four parents it will write, up front and in `db/partitions.ts#PARTITIONED_TABLES` order — the
 * same order the maintenance job walks them in. A transaction that already holds every lock it will
 * ever need cannot be half of a deadlock; the DDL in the other fork simply waits, well inside the
 * 15-second `lock_timeout` `ensurePartitions` sets, because these tests run in about a second.
 *
 * `RETRY` stays as the backstop for the acquisition itself, which can still lose a race with the
 * other fork's `ACCESS EXCLUSIVE` drops. A retried test re-runs `beforeEach` and starts from a
 * fresh transaction and a fresh fixture — the test-shaped version of what production does when
 * `partitionMaintenance` and `cboeQuotes` overlap at 01:00: the poller comes back on the next tick.
 */

import { describe, expect, it } from 'vitest';

import { PARTITIONED_TABLES } from '../../../src/db/partitions.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { runCboeEuIndices } from '../../../src/ingest/jobs/cboeEuIndices.js';
import { runCboeOptions } from '../../../src/ingest/jobs/cboeOptions.js';
import { runCboeQuotes } from '../../../src/ingest/jobs/cboeQuotes.js';
import { runCrypto } from '../../../src/ingest/jobs/crypto.js';
import { runFxEod } from '../../../src/ingest/jobs/fxEod.js';
import { runFxIntraday } from '../../../src/ingest/jobs/fxIntraday.js';
import { runYahooDaily } from '../../../src/ingest/jobs/yahooDaily.js';
import { runYahooIntraday } from '../../../src/ingest/jobs/yahooIntraday.js';
import { frozenClock, TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { AssetClass, NormalisedUpdate } from '@terminal/core';
import type { MarketJobContext, MarketJobResult } from '../../../src/ingest/jobs/cboeQuotes.js';
import type { TestDb } from '../../../src/test/db.js';

/** The captures were all taken on 2026-09-15; `TEST_NOW` is two days later, inside every window. */
const VALID_FROM = new Date('2020-01-01T00:00:00Z');

const store = openReplayStore();
const clock = frozenClock(TEST_NOW);

/** A plant that records what it was handed — WP-06 owns the real one. */
class RecordingPlant {
  readonly updates: NormalisedUpdate[] = [];
  apply(update: NormalisedUpdate): void {
    this.updates.push(update);
  }
}

interface Line {
  instrumentId: number;
  mdLineId: number;
  providerSymbol: string;
}

/** One bootstrap `provenance` row, so the master repositories have something to cite. */
async function bootstrapProvenance(t: TestDb, sourceId: string, label: string): Promise<number> {
  const key = `${label}-${String(Math.random()).slice(2)}`;
  const res = await t.client.query<{ provenance_id: string }>(
    `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                             http_status, bytes, captured_at, adapter_version)
     VALUES ($1, $2, 'test://wp05/' || $2, digest($2, 'sha256'), digest($2, 'sha256'),
             200, 0, $3, 'test/1.0.0')
     RETURNING provenance_id`,
    [sourceId, key, new Date(TEST_NOW).toISOString()],
  );
  return Number(res.rows[0]!.provenance_id);
}

/**
 * An instrument and one md line for it, through WP-04's repositories.
 *
 * The md line's `intrinsic_delay_min`, `expected_interval_ms` and `priority` are the values each
 * provider section's "Staleness tier" paragraph states — 15 min / 10 s / 10 for `cboe.quotes`,
 * 15 min / 60 s / 20 for `yahoo.chart`, 0 / 86 400 s / 30 for the `frankfurter` reference line —
 * because the tier those numbers produce is half of what these tests are checking.
 */
async function makeLine(
  t: TestDb,
  spec: {
    ticker: string;
    name: string;
    assetClass: AssetClass;
    marketSector: 'Equity' | 'Index' | 'Curncy' | 'Comdty';
    exchCode: string;
    currency: string;
    sourceId: string;
    providerSymbol: string;
    lineKind: 'composite' | 'reference';
    intrinsicDelayMin: number;
    expectedIntervalMs: number;
    priority: number;
  },
): Promise<Line> {
  const repos = masterRepositories(t.db);
  const provenanceId = await bootstrapProvenance(t, 'internal.user', `master-${spec.ticker}`);
  const o = { validFrom: VALID_FROM, provenanceId };

  const issuerId = await repos.issuers.insert({ name: `${spec.name} issuer` }, o);
  const issueId = await repos.issues.insert(
    {
      issuerId,
      assetClass: spec.assetClass,
      securityType: spec.assetClass === 'equity' ? 'Common Stock' : 'Index',
      name: spec.name,
      currency: spec.currency,
    },
    o,
  );
  const instrumentId = await repos.instruments.insert(
    {
      issueId,
      assetClass: spec.assetClass,
      marketSector: spec.marketSector,
      ticker: spec.ticker,
      exchCode: spec.exchCode,
      name: spec.name,
      currency: spec.currency,
    },
    o,
  );
  const { mdLineId } = await repos.mdLines.upsertBySymbol(
    {
      instrumentId,
      sourceId: spec.sourceId,
      providerSymbol: spec.providerSymbol,
      lineKind: spec.lineKind,
      intrinsicDelayMin: spec.intrinsicDelayMin,
      expectedIntervalMs: spec.expectedIntervalMs,
      priority: spec.priority,
    },
    o,
  );
  return { instrumentId, mdLineId, providerSymbol: spec.providerSymbol };
}

function context(t: TestDb, plant: RecordingPlant): MarketJobContext {
  return { tx: t.db, clock, replay: store, plant, log: {} };
}

/**
 * `SELECT count(*)` — the only kind of idempotency evidence this file accepts.
 *
 * Every call is scoped to rows this test created (its own md lines, its own instrument), because
 * `bloomberg_test` is shared: `globalSetup` seeds it and the `withCleanDb` suites commit into it,
 * so an unscoped `count(*)` over `provenance` would assert on other people's rows.
 */
async function count(t: TestDb, table: string, where = 'TRUE'): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
  );
  return Number(res.rows[0]!.n);
}

/** See the locking note at the top of the file: partition DDL in a sibling fork, not flakiness. */
const RETRY = { retry: 2 } as const;

/**
 * Take `ROW EXCLUSIVE` on every partitioned parent this file writes, in `PARTITIONED_TABLES` order.
 *
 * Not an optimisation and not a fudge: holding every lock the transaction will need before it needs
 * any of them is the standard way to make a lock cycle impossible, and the order is the one the
 * maintenance job itself walks so the two agree. `ROW EXCLUSIVE` is exactly the mode an `INSERT`
 * would take anyway — this changes when the locks are acquired, never which.
 */
async function lockMarketTables(t: TestDb): Promise<void> {
  const tables = PARTITIONED_TABLES.filter(
    (table) => table !== 'access_log' && table !== 'usage_events',
  );
  await t.client.query(`LOCK TABLE ${tables.join(', ')} IN ROW EXCLUSIVE MODE`);
}

/** Rows written by *this* run, named by the provenance ids it reported. */
function byProvenance(ids: readonly number[]): string {
  return ids.length === 0 ? 'FALSE' : `provenance_id IN (${ids.map(String).join(', ')})`;
}

function expectNoErrors(result: MarketJobResult): void {
  expect(result.errors).toEqual([]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('cboeQuotes writes one tick per capture and nothing on a re-run', () => {
  const t = withTxDb();

  it('is idempotent by row count, and tags every value 15-minute delayed', RETRY, async () => {
    await lockMarketTables(t);
    const aapl = await makeLine(t, {
      ticker: 'AAPL',
      name: 'Apple Inc',
      assetClass: 'equity',
      marketSector: 'Equity',
      exchCode: 'US',
      currency: 'USD',
      sourceId: 'cboe.quotes',
      providerSymbol: 'AAPL',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 10_000,
      priority: 10,
    });
    const vix = await makeLine(t, {
      ticker: 'VIX',
      name: 'Cboe Volatility Index',
      assetClass: 'index',
      marketSector: 'Index',
      exchCode: 'INDEX',
      currency: 'USD',
      sourceId: 'cboe.quotes',
      providerSymbol: '_VIX',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 10_000,
      priority: 10,
    });

    const lineIds = `md_line_id IN (${String(aapl.mdLineId)}, ${String(vix.mdLineId)})`;
    const plant = new RecordingPlant();

    const first = await runCboeQuotes(context(t, plant));
    expectNoErrors(first);
    expect(first.fetched).toBe(2);
    expect(first.inserted).toBe(2);
    expect(await count(t, 'quote_ticks', lineIds)).toBe(2);

    // One provenance row per exchange (§1.3), and every tick points at one of them.
    expect(first.provenanceIds).toHaveLength(2);
    expect(await count(t, 'provenance', byProvenance(first.provenanceIds))).toBe(2);
    expect(
      await count(t, 'quote_ticks', `${lineIds} AND ${byProvenance(first.provenanceIds)}`),
    ).toBe(2);

    // ── the re-run ──────────────────────────────────────────────────────────────────────────
    const second = await runCboeQuotes(context(t, plant));
    expectNoErrors(second);
    expect(second.fetched).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(await count(t, 'quote_ticks', lineIds)).toBe(2);
    // The exchange happened twice, so provenance grew; the values did not. The second run's two
    // rows exist and nothing points at them.
    expect(second.provenanceIds).toHaveLength(2);
    expect(await count(t, 'provenance', byProvenance(second.provenanceIds))).toBe(2);
    expect(
      await count(t, 'quote_ticks', `${lineIds} AND ${byProvenance(second.provenanceIds)}`),
    ).toBe(0);

    // ── staleness (TERM-12) ─────────────────────────────────────────────────────────────────
    const tick = await t.client.query<{
      conditions: string[];
      source_ts: Date | null;
      price: string | null;
      iv30: string | null;
    }>(
      `SELECT conditions, source_ts, price, iv30 FROM quote_ticks
        WHERE md_line_id = $1`,
      [aapl.mdLineId],
    );
    expect(tick.rows).toHaveLength(1);
    // FEED-07: the only condition a delayed poll may assert.
    expect(tick.rows[0]!.conditions).toEqual(['delayed']);
    // §5.1: `source_ts` is the provider's own `last_trade_time`, not the fetch instant.
    expect(tick.rows[0]!.source_ts).not.toBeNull();
    expect(Number(tick.rows[0]!.price)).toBeGreaterThan(0);

    // The plant saw both polls; every update carries the licence's `max_tier` and the line's delay.
    expect(plant.updates.length).toBe(4);
    const allProvenanceIds = new Set([...first.provenanceIds, ...second.provenanceIds]);
    for (const update of plant.updates) {
      expect(update.tier).toBe('delayed');
      expect(update.prov.sourceId).toBe('cboe.quotes');
      // The sentinel id the pre-parse ran against never reaches an update.
      expect(allProvenanceIds.has(update.prov.provenanceId)).toBe(true);
      // `cap` is the capture instant of 2026-09-15, not the day the replay ran.
      expect(new Date(update.ts.cap).toISOString().slice(0, 10)).toBe('2026-09-15');
    }
    const delays = await t.client.query<{ intrinsic_delay_min: number }>(
      `SELECT intrinsic_delay_min FROM md_lines WHERE ${lineIds} AND tx_to = 'infinity'`,
    );
    expect(delays.rows.map((r) => r.intrinsic_delay_min)).toEqual([15, 15]);

    // ── one ingest_runs row per execution, job_id = the module basename (§13) ────────────────
    const runs = await t.client.query<{ job_id: string; status: string; source_id: string }>(
      `SELECT job_id, status, source_id FROM ingest_runs
        WHERE job_id = 'cboeQuotes' ORDER BY run_id`,
    );
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows.map((r) => r.job_id)).toEqual(['cboeQuotes', 'cboeQuotes']);
    expect(runs.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(runs.rows.map((r) => r.source_id)).toEqual(['cboe.quotes', 'cboe.quotes']);
  });
});

describe('crypto covers the whole universe in one request', () => {
  const t = withTxDb();

  it('is idempotent by row count and carries no source timestamp (§5.8)', RETRY, async () => {
    await lockMarketTables(t);
    const lines: Line[] = [];
    for (const [ticker, slug, name] of [
      ['XBT', 'bitcoin', 'Bitcoin'],
      ['ETH', 'ethereum', 'Ethereum'],
    ] as const) {
      lines.push(
        await makeLine(t, {
          ticker,
          name,
          assetClass: 'crypto',
          marketSector: 'Comdty',
          exchCode: 'CRYPTO',
          currency: 'USD',
          sourceId: 'coingecko.simple',
          providerSymbol: slug,
          lineKind: 'composite',
          intrinsicDelayMin: 0,
          expectedIntervalMs: 60_000,
          priority: 20,
        }),
      );
    }
    const lineIds = `md_line_id IN (${lines.map((l) => String(l.mdLineId)).join(', ')})`;
    const plant = new RecordingPlant();

    const first = await runCrypto(context(t, plant));
    expectNoErrors(first);
    // One request for both ids — that is the whole point of the §13 row.
    expect(first.fetched).toBe(1);
    expect(first.provenanceIds).toHaveLength(1);
    expect(first.inserted).toBe(2);
    expect(await count(t, 'quote_ticks', lineIds)).toBe(2);

    const second = await runCrypto(context(t, plant));
    expectNoErrors(second);
    expect(second.fetched).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(await count(t, 'quote_ticks', lineIds)).toBe(2);

    const rows = await t.client.query<{
      source_ts: Date | null;
      session_state: string;
      price: string;
      prev_close: string | null;
    }>(
      `SELECT source_ts, session_state, price, prev_close FROM quote_ticks
        WHERE ${lineIds} ORDER BY price DESC`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      // §5.8: the payload carries no instant at all, and crypto never closes.
      expect(row.source_ts).toBeNull();
      expect(row.session_state).toBe('open');
      expect(Number(row.price)).toBeGreaterThan(0);
      // The implied 24-hour-ago price, reconstructed from `usd_24h_change`.
      expect(Number(row.prev_close)).toBeGreaterThan(0);
    }
    // The recorded capture: bitcoin 75828, ethereum 2386.91.
    expect(Number(rows.rows[0]!.price)).toBeCloseTo(75828, 6);
    expect(Number(rows.rows[1]!.price)).toBeCloseTo(2386.91, 6);

    // `provenance.source_ts` is NULL for this source, always (§5.8).
    const ids = [...first.provenanceIds, ...second.provenanceIds];
    const prov = await t.client.query<{ source_ts: Date | null }>(
      `SELECT source_ts FROM provenance WHERE provenance_id = ANY($1::bigint[])`,
      [ids],
    );
    expect(prov.rows).toHaveLength(2);
    expect(prov.rows.every((r) => r.source_ts === null)).toBe(true);

    expect(await count(t, 'ingest_runs', `job_id = 'crypto'`)).toBe(2);
  });
});

describe('yahooIntraday upserts bars on their natural key', () => {
  const t = withTxDb();

  it('writes the capture once and restates nothing on a re-run', RETRY, async () => {
    await lockMarketTables(t);
    const ftse = await makeLine(t, {
      ticker: 'UKX',
      name: 'FTSE 100',
      assetClass: 'index',
      marketSector: 'Index',
      exchCode: 'INDEX',
      currency: 'GBP',
      sourceId: 'yahoo.chart',
      providerSymbol: '^FTSE',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 20,
    });
    const where = `instrument_id = ${String(ftse.instrumentId)}`;
    const plant = new RecordingPlant();

    const first = await runYahooIntraday(context(t, plant));
    expectNoErrors(first);
    expect(first.fetched).toBe(1);
    const bars = await count(t, 'bars_intraday', where);
    expect(bars).toBeGreaterThan(0);
    expect(first.inserted).toBe(bars);

    const second = await runYahooIntraday(context(t, plant));
    expectNoErrors(second);
    expect(second.fetched).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    // `unchanged` is what `skipped` reports: every bar of the capture, untouched.
    expect(second.skipped).toBe(bars);
    expect(await count(t, 'bars_intraday', where)).toBe(bars);

    // §5.5: `bar_interval` is the granularity Yahoo actually returned, and the last bar of a poll
    // is the only one not yet final.
    const shape = await t.client.query<{ bar_interval: string; finals: string; opens: string }>(
      `SELECT bar_interval,
              count(*) FILTER (WHERE is_final)::text     AS finals,
              count(*) FILTER (WHERE NOT is_final)::text AS opens
         FROM bars_intraday WHERE ${where} GROUP BY bar_interval`,
    );
    expect(shape.rows).toHaveLength(1);
    expect(shape.rows[0]!.bar_interval).toBe('5m');
    expect(Number(shape.rows[0]!.opens)).toBe(1);
    expect(Number(shape.rows[0]!.finals)).toBe(bars - 1);

    expect(await count(t, 'ingest_runs', `job_id = 'yahooIntraday'`)).toBe(2);
  });
});

describe('fxEod distributes one fixing over every frankfurter line', () => {
  const t = withTxDb();

  it('writes both rate directions once and nothing on a re-run', RETRY, async () => {
    await lockMarketTables(t);
    const reference = await makeLine(t, {
      ticker: 'USD',
      name: 'US Dollar reference line',
      assetClass: 'fx',
      marketSector: 'Curncy',
      exchCode: 'FX',
      currency: 'USD',
      sourceId: 'frankfurter',
      providerSymbol: 'USD',
      lineKind: 'reference',
      intrinsicDelayMin: 0,
      expectedIntervalMs: 86_400_000,
      priority: 30,
    });
    const eurusd = await makeLine(t, {
      ticker: 'EURUSD',
      name: 'Euro / US Dollar',
      assetClass: 'fx',
      marketSector: 'Curncy',
      exchCode: 'FX',
      currency: 'USD',
      sourceId: 'frankfurter',
      providerSymbol: 'EURUSD',
      lineKind: 'composite',
      intrinsicDelayMin: 0,
      expectedIntervalMs: 86_400_000,
      priority: 30,
    });
    const plant = new RecordingPlant();

    const first = await runFxEod(context(t, plant));
    expectNoErrors(first);
    expect(first.fetched).toBe(1);

    const rates = await count(t, 'fx_rates', `source_id = 'frankfurter'`);
    // §5.7: both directions for every published currency, so the count is even and > 2.
    expect(rates).toBeGreaterThan(2);
    expect(rates % 2).toBe(0);
    const bars = await count(t, 'bars_daily', `instrument_id = ${String(eurusd.instrumentId)}`);
    expect(bars).toBe(1);
    expect(first.inserted).toBe(rates + bars);

    const second = await runFxEod(context(t, plant));
    expectNoErrors(second);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(rates + bars);
    expect(await count(t, 'fx_rates', `source_id = 'frankfurter'`)).toBe(rates);
    expect(await count(t, 'bars_daily', `instrument_id = ${String(eurusd.instrumentId)}`)).toBe(1);

    // §5.7: the ECB publishes a fixing, not a bar — OHLV stay NULL and only `close` is stated.
    const bar = await t.client.query<{
      open: string | null;
      high: string | null;
      low: string | null;
      volume: string | null;
      close: string;
      session_date: string;
    }>(
      `SELECT open, high, low, volume, close, session_date::text AS session_date
         FROM bars_daily WHERE instrument_id = $1`,
      [eurusd.instrumentId],
    );
    expect(bar.rows).toHaveLength(1);
    expect(bar.rows[0]!.open).toBeNull();
    expect(bar.rows[0]!.high).toBeNull();
    expect(bar.rows[0]!.low).toBeNull();
    expect(bar.rows[0]!.volume).toBeNull();
    expect(bar.rows[0]!.session_date).toBe('2026-09-15');
    // EUR/USD is the inverted quote: 1 / rates.EUR, and the capture's EUR is 0.86663.
    expect(Number(bar.rows[0]!.close)).toBeCloseTo(1 / 0.86663, 5);

    // The reference line ticks with no fields at all, so `ts.cap` advances and staleness can count
    // missed fixings; the pair line carries only `PX_OFFICIAL_CLOSE` (§5.7 — `PX_LAST` is Yahoo's).
    const referenceUpdates = plant.updates.filter((u) => u.mdLineId === reference.mdLineId);
    const pairUpdates = plant.updates.filter((u) => u.mdLineId === eurusd.mdLineId);
    expect(referenceUpdates).toHaveLength(2);
    expect(Object.keys(referenceUpdates[0]!.fields)).toEqual([]);
    expect(pairUpdates).toHaveLength(2);
    expect(Object.keys(pairUpdates[0]!.fields)).toEqual(['PX_OFFICIAL_CLOSE']);
    // `frankfurter`'s licence ceiling is `eod`, not `delayed` — the tier is read, never assumed.
    expect(pairUpdates[0]!.tier).toBe('eod');

    expect(await count(t, 'ingest_runs', `job_id = 'fxEod'`)).toBe(2);
  });
});

describe('cboeOptions mints a chain and re-writes none of it', () => {
  const t = withTxDb();

  it('mints every contract once and writes one option_quotes row per contract', RETRY, async () => {
    await lockMarketTables(t);
    const aapl = await makeLine(t, {
      ticker: 'AAPL',
      name: 'Apple Inc',
      assetClass: 'equity',
      marketSector: 'Equity',
      exchCode: 'US',
      currency: 'USD',
      sourceId: 'cboe.options',
      providerSymbol: 'AAPL',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 10,
    });
    const underlying = `underlying_instrument_id = ${String(aapl.instrumentId)}`;
    const plant = new RecordingPlant();

    const first = await runCboeOptions(context(t, plant));
    expectNoErrors(first);
    expect(first.fetched).toBe(1);

    const quotes = await count(t, 'option_quotes', underlying);
    const terms = await count(t, 'option_terms', underlying);
    // The recorded AAPL chain: 3,510 contracts, one `option_terms` version and one quote each.
    expect(quotes).toBe(3510);
    expect(terms).toBe(3510);
    // Every contract also got an instrument and an OCC identifier.
    expect(await count(t, 'identifiers', `scheme = 'OCC' AND value LIKE 'AAPL%'`)).toBe(3510);

    // ── the re-run: every contract resolves, nothing is minted, nothing is restated ──────────
    const second = await runCboeOptions(context(t, plant));
    expectNoErrors(second);
    expect(second.fetched).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(await count(t, 'option_quotes', underlying)).toBe(quotes);
    expect(await count(t, 'option_terms', underlying)).toBe(terms);
    expect(await count(t, 'identifiers', `scheme = 'OCC' AND value LIKE 'AAPL%'`)).toBe(3510);

    // §5.2: only subscribed contracts and the ATM window reach the plant — never 3,510 subjects.
    const contractUpdates = plant.updates.filter(
      (u) => u.subject !== `q:${String(aapl.instrumentId)}`,
    );
    expect(contractUpdates.length).toBeGreaterThan(0);
    expect(contractUpdates.length).toBeLessThan(quotes);

    // The underlying block travels in the same payload, on the `cboe.options` line (§5.2 step 1).
    expect(await count(t, 'quote_ticks', `md_line_id = ${String(aapl.mdLineId)}`)).toBe(1);

    expect(await count(t, 'ingest_runs', `job_id = 'cboeOptions'`)).toBe(2);
  });
});

describe('cboeEuIndices feeds WEI and mints the provider symbol once', () => {
  const t = withTxDb();

  it('is idempotent across ticks and identifier versions alike', RETRY, async () => {
    await lockMarketTables(t);
    const ukx = await makeLine(t, {
      ticker: 'BUK100P',
      name: 'Cboe UK 100',
      assetClass: 'index',
      marketSector: 'Index',
      exchCode: 'INDEX',
      currency: 'GBP',
      sourceId: 'cboe.euIndices',
      providerSymbol: 'BUK100P',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 10,
    });
    const line = `md_line_id = ${String(ukx.mdLineId)}`;
    const identifier =
      `entity_kind = 'instrument' AND entity_id = ${String(ukx.instrumentId)} ` +
      `AND scheme = 'PROVIDER_SYMBOL' AND qualifier = 'cboe.euIndices'`;
    const plant = new RecordingPlant();

    const first = await runCboeEuIndices(context(t, plant));
    expectNoErrors(first);
    expect(first.fetched).toBe(1);
    expect(await count(t, 'quote_ticks', line)).toBe(1);
    // §5.4: `data.symbol` (`^BUK100P-SL`) is kept as a PROVIDER_SYMBOL identifier.
    expect(await count(t, 'identifiers', identifier)).toBe(1);

    const second = await runCboeEuIndices(context(t, plant));
    expectNoErrors(second);
    expect(second.inserted).toBe(0);
    expect(await count(t, 'quote_ticks', line)).toBe(1);
    // `upsertIfValid` wrote no second version: one row, still current.
    expect(await count(t, 'identifiers', `${identifier} AND tx_to = 'infinity'`)).toBe(1);

    // §5.4: a European index publishes no book, no volume and no IV — all dropped.
    const tick = await t.client.query<{
      bid: string | null;
      ask: string | null;
      volume: string | null;
      iv30: string | null;
      source_ts: Date | null;
      price: string | null;
    }>(`SELECT bid, ask, volume, iv30, source_ts, price FROM quote_ticks WHERE ${line}`);
    expect(tick.rows).toHaveLength(1);
    expect(tick.rows[0]!.bid).toBeNull();
    expect(tick.rows[0]!.ask).toBeNull();
    expect(tick.rows[0]!.volume).toBeNull();
    expect(tick.rows[0]!.iv30).toBeNull();
    // §5.4: `source_ts` comes from `last_trade_time`, never from the bare top-level time.
    expect(tick.rows[0]!.source_ts).not.toBeNull();
    expect(Number(tick.rows[0]!.price)).toBeGreaterThan(0);

    expect(await count(t, 'ingest_runs', `job_id = 'cboeEuIndices'`)).toBe(2);
  });
});

describe('fxIntraday polls only the seeded G10 pairs', () => {
  const t = withTxDb();

  it('writes the capture once and leaves it alone on a re-run', RETRY, async () => {
    await lockMarketTables(t);
    const eurusd = await makeLine(t, {
      ticker: 'EURUSD',
      name: 'Euro / US Dollar',
      assetClass: 'fx',
      marketSector: 'Curncy',
      exchCode: 'FX',
      currency: 'USD',
      sourceId: 'yahoo.chart',
      providerSymbol: 'EURUSD=X',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 20,
    });
    // A Yahoo line that is *not* an FX pair must not be polled by this job.
    const aapl = await makeLine(t, {
      ticker: 'AAPL',
      name: 'Apple Inc',
      assetClass: 'equity',
      marketSector: 'Equity',
      exchCode: 'US',
      currency: 'USD',
      sourceId: 'yahoo.chart',
      providerSymbol: 'AAPL',
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: 60_000,
      priority: 20,
    });
    const plant = new RecordingPlant();

    const first = await runFxIntraday(context(t, plant));
    expectNoErrors(first);
    // One request: the pair, never the equity line.
    expect(first.fetched).toBe(1);
    const bars = await count(t, 'bars_intraday', `instrument_id = ${String(eurusd.instrumentId)}`);
    expect(bars).toBeGreaterThan(0);
    expect(await count(t, 'bars_intraday', `instrument_id = ${String(aapl.instrumentId)}`)).toBe(0);

    const second = await runFxIntraday(context(t, plant));
    expectNoErrors(second);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(bars);
    expect(await count(t, 'bars_intraday', `instrument_id = ${String(eurusd.instrumentId)}`)).toBe(
      bars,
    );

    expect(await count(t, 'ingest_runs', `job_id = 'fxIntraday'`)).toBe(2);
  });
});

describe('yahooDaily writes the daily history and queues the corporate actions', () => {
  const t = withTxDb();

  it(
    'restates no bar and writes no second corporate-action version on a re-run',
    RETRY,
    async () => {
      await lockMarketTables(t);
      const aapl = await makeLine(t, {
        ticker: 'AAPL',
        name: 'Apple Inc',
        assetClass: 'equity',
        marketSector: 'Equity',
        exchCode: 'US',
        currency: 'USD',
        sourceId: 'yahoo.chart',
        providerSymbol: 'AAPL',
        lineKind: 'composite',
        intrinsicDelayMin: 15,
        expectedIntervalMs: 60_000,
        priority: 20,
      });
      const instrument = `instrument_id = ${String(aapl.instrumentId)}`;
      const plant = new RecordingPlant();

      const first = await runYahooDaily(context(t, plant));
      expectNoErrors(first);
      expect(first.fetched).toBe(1);

      const bars = await count(t, 'bars_daily', instrument);
      const actions = await count(t, 'corporate_actions', `${instrument} AND tx_to = 'infinity'`);
      // The `range=5y&interval=1d` capture: a full five years of sessions and the dividend block.
      expect(bars).toBeGreaterThan(1000);
      expect(actions).toBeGreaterThan(0);
      // REF-10: a parsed action never adjusts a price until data-ops reviews it.
      expect(await count(t, 'corporate_actions', `${instrument} AND review_state = 'queued'`)).toBe(
        actions,
      );

      const second = await runYahooDaily(context(t, plant));
      expectNoErrors(second);
      expect(second.inserted).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.skipped).toBe(bars + actions);
      expect(await count(t, 'bars_daily', instrument)).toBe(bars);
      // `upsertVersion` on the natural key: no second version, and no second `ca_id`.
      expect(await count(t, 'corporate_actions', instrument)).toBe(actions);

      expect(await count(t, 'ingest_runs', `job_id = 'yahooDaily'`)).toBe(2);
    },
  );
});
