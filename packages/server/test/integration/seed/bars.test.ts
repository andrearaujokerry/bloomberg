/**
 * Seed modules 8 and 9 (DATA_MODEL §18 rows 8-9) off the replay store: the bar history, the
 * corporate actions, the ECB fixing, the 3,510-contract AAPL option chain and the plant's warm
 * start.
 *
 * The volumes asserted here are the **measured** ones, and where they differ from §18 the difference
 * is stated in the assertion rather than smoothed over — §18's row is a target written before the
 * fixtures were cut, and a seed that quietly wrote 400 bars where the table says 1,450 has failed
 * quietly. Each divergence below is a fixture fact:
 *
 *  - `bars_intraday` is 1,033, not 1,110: §18 counts `yahoo-bond`'s 75 `^TNX` bars, and no §18 row-5
 *    instrument covers `^TNX` (it is not one of the 31 indices), so the capture has no md line to
 *    arrive on. Two further bars are dropped by the parser as incomplete (§5.5).
 *  - `fx_rates` is 58, not 29: the frankfurter payload carries 29 currencies and §5.7 writes **both
 *    directions** of each, which is what makes a cross-rate read unconditional.
 *  - `corporate_actions` is 25, not ≈24: the `range=max` capture carries five splits (three
 *    historical 2:1, the 2014 7:1 and the 2020 4:1), and §18 counted four.
 *  - `quote_ticks` is 5, not 4: the AAPL option chain publishes its underlying's top of book on the
 *    `cboe.options` line as well (§5.2 step 1), which is a fifth observed change.
 *
 * `test/globalSetup.ts` has already run the seed, so the module is re-run inside this test's
 * transaction to prove it writes nothing the second time; everything is rolled back.
 */

import { describe, expect, it } from 'vitest';

import { PARTITIONED_TABLES } from '../../../src/db/partitions.js';
import { getConfig } from '../../../src/config.js';
import { BARS_TABLES, CBOE_BACKFILL, seedBars } from '../../../src/seed/bars.js';
import { countTables } from '../../../src/seed/rates.js';
import { frozenClock, TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { SeedContext } from '../../../src/seed/index.js';
import type { TestDb } from '../../../src/test/db.js';

/** See `test/integration/ingest/marketDataJobs.test.ts`: partition DDL in a sibling fork. */
const RETRY = { retry: 2 } as const;

/** The session every Cboe capture belongs to. */
const SESSION = '2026-09-15';

function seedContext(t: TestDb, log: string[] = []): SeedContext {
  return {
    query: (text, values) => t.client.query(text, values),
    db: t.db,
    config: getConfig(),
    clock: frozenClock(TEST_NOW),
    log: (message) => log.push(message),
  };
}

/**
 * Hold every lock this file will need before it needs any of them — the same reason
 * `marketDataJobs.test.ts` does it: `partitions.test.ts` commits `CREATE`/`DROP … PARTITION OF` on
 * these parents in a sibling fork, and a transaction that acquires its locks up front, in
 * `PARTITIONED_TABLES` order, cannot be half of a cycle.
 */
async function lockMarketTables(t: TestDb): Promise<void> {
  const tables = PARTITIONED_TABLES.filter((n) => n !== 'access_log' && n !== 'usage_events');
  await t.client.query(`LOCK TABLE ${tables.join(', ')} IN ROW EXCLUSIVE MODE`);
}

async function rows<R extends Record<string, unknown>>(t: TestDb, sql: string): Promise<R[]> {
  return (await t.client.query<R>(sql)).rows;
}

async function count(t: TestDb, table: string, where = 'TRUE'): Promise<number> {
  const row = (await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
  )).rows[0];
  return Number(row?.n ?? '0');
}

/** The instrument behind an md line, at the capture instant. */
async function instrumentOf(t: TestDb, sourceId: string, symbol: string): Promise<number> {
  const row = (await t.client.query<{ id: string }>(
    `SELECT instrument_id::text AS id FROM md_lines
      WHERE source_id = $1 AND provider_symbol = $2 AND tx_to = 'infinity' ORDER BY md_line_id LIMIT 1`,
    [sourceId, symbol],
  )).rows[0];
  if (row === undefined) throw new Error(`no ${sourceId} line for ${symbol}`);
  return Number(row.id);
}

describe('seed/bars writes the §18 row 8-9 history and nothing the second time', () => {
  const t = withTxDb();

  it('is idempotent by table delta', RETRY, async () => {
    await lockMarketTables(t);
    const ctx = seedContext(t);
    await seedBars(ctx);

    const before = await countTables(t.db, BARS_TABLES);
    const deltas = await seedBars(ctx);
    const after = await countTables(t.db, BARS_TABLES);
    for (const table of BARS_TABLES) {
      expect(deltas[table], `${table} delta`).toBe(0);
      expect(after[table], `${table} count`).toBe(before[table]);
    }
  });

  it('rewrites no eod_snapshots row on a second run, and says why quote_snapshots differs', RETRY, async () => {
    await lockMarketTables(t);
    const ctx = seedContext(t);
    await seedBars(ctx);

    // `ctid` is the tuple's physical identity: an UPDATE writes a new tuple and moves it, so an
    // unchanged `ctid` is proof the `IS DISTINCT FROM` guard declined to rewrite the row. A delta of
    // zero cannot show this — an upsert that rewrites four rows leaves the count alone.
    const eodBefore = await rows<{ id: string }>(
      t,
      'SELECT ctid::text AS id FROM eod_snapshots ORDER BY instrument_id',
    );
    const snapBefore = await rows<{ id: string; state: string }>(
      t,
      'SELECT ctid::text AS id, state::text AS state FROM quote_snapshots ORDER BY instrument_id',
    );

    await seedBars(ctx);

    expect(await rows<{ id: string }>(t, 'SELECT ctid::text AS id FROM eod_snapshots ORDER BY instrument_id')).toEqual(eodBefore);

    // `quote_snapshots` is byte-identical too, ids included, and that is a change worth naming.
    // This assertion used to compare the two states with `"provenanceId":\d+` masked out, and the
    // comment above it explained that the ids necessarily move because PROVIDERS.a §1.3 records one
    // `provenance` row per exchange. That reasoning was right about live mode and wrong here: in
    // `PROVIDER_MODE=replay` NOTHING is exchanged, so a second run must not record a second
    // exchange, and the mask was hiding the four rows this module rewrote on every `db:seed` to cite
    // ids that stood for nothing. The leg gate (`seed/fundamentals.ts#recordedLegs`) is what stopped
    // it, and the unmasked comparison is what keeps it stopped.
    const snapAfter = await rows<{ id: string; state: string }>(
      t,
      'SELECT ctid::text AS id, state::text AS state FROM quote_snapshots ORDER BY instrument_id',
    );
    expect(snapAfter).toEqual(snapBefore);
  });

  it('reports a snapshot it UPDATED rather than the row count, which does not move', RETRY, async () => {
    await lockMarketTables(t);
    const ctx = seedContext(t);

    // The summary printed `quote_snapshots=0` while its own detail line said "4 quote_snapshots
    // (0 unchanged)", because it reported a row-count delta and `quote_snapshots` is keyed on
    // `instrument_id`: four rewritten rows move no count. This drives the case the summary has to
    // describe — a state the module must replace — and asserts the number it reports.
    //
    // Deleting `quote_ticks` is how the Cboe legs are made to run again: they are gated on their own
    // output, and the plant has to be repopulated before `writeWarmStart` has anything to write.
    const before = await count(t, 'quote_snapshots');
    expect(before).toBe(4);
    await t.client.query(`DELETE FROM quote_ticks`);
    await t.client.query(
      `UPDATE quote_snapshots SET state = jsonb_set(state, '{seq}', '1'::jsonb)
        WHERE instrument_id = (SELECT min(instrument_id) FROM quote_snapshots)`,
    );

    const deltas = await seedBars(ctx);

    expect(await count(t, 'quote_snapshots'), 'the row count cannot see a rewrite').toBe(before);
    expect(
      deltas.quote_snapshots,
      'seed/bars must report the snapshots it CHANGED; a row-count delta reports 0 for a rewrite ' +
        'and the run reads as a no-op when it replaced every state in the table',
    ).toBeGreaterThanOrEqual(1);
  });

  it('writes the AAPL daily history, the dividends and the splits from two captures', RETRY, async () => {
    await lockMarketTables(t);
    await seedBars(seedContext(t));
    const aapl = await instrumentOf(t, 'yahoo.chart', 'AAPL');

    // `yahoo-chart-events`: five years of sessions at 1d granularity.
    expect(await count(t, 'bars_daily', `instrument_id = ${String(aapl)}`)).toBe(1255);

    // The 20 dividends of the five-year capture and the five splits of the `range=max` one. The
    // quarterly capture's other 72 dividends are deliberately not taken (§18 row 8).
    const actions = await rows<{ ca_type: string; n: string }>(
      t,
      `SELECT ca_type, count(*)::text AS n FROM corporate_actions
        WHERE instrument_id = ${String(aapl)} AND tx_to = 'infinity'
        GROUP BY ca_type ORDER BY ca_type`,
    );
    expect(actions).toEqual([
      { ca_type: 'cash_dividend', n: '20' },
      { ca_type: 'split', n: '5' },
    ]);
    const splits = await rows<{ ex_date: string; ratio_new: string; ratio_old: string }>(
      t,
      `SELECT ex_date::text AS ex_date, ratio_new::text AS ratio_new, ratio_old::text AS ratio_old
         FROM corporate_actions
        WHERE instrument_id = ${String(aapl)} AND ca_type = 'split' AND tx_to = 'infinity'
        ORDER BY ex_date`,
    );
    expect(splits.map((s) => s.ex_date)).toEqual([
      '1987-06-16',
      '2000-06-21',
      '2005-02-28',
      '2014-06-09',
      '2020-08-31',
    ]);
    expect(splits.map((s) => `${Number(s.ratio_new)}:${Number(s.ratio_old)}`)).toEqual([
      '2:1',
      '2:1',
      '2:1',
      '7:1',
      '4:1',
    ]);
    // REF-10: a parsed action adjusts nothing until data-ops reviews it.
    expect(
      await count(
        t,
        'corporate_actions',
        `instrument_id = ${String(aapl)} AND tx_to = 'infinity' AND review_state <> 'queued'`,
      ),
    ).toBe(0);

    // The quarterly capture wrote no bar: coarse bars are not daily bars (PROVIDERS §5.5). Its 169
    // rows reach back to 1980, so a single bar older than the five-year window would prove it had
    // been written into `bars_daily` anyway.
    const span = (
      await rows<{ first: string; last: string }>(
        t,
        `SELECT min(session_date)::text AS first, max(session_date)::text AS last
           FROM bars_daily WHERE instrument_id = ${String(aapl)}`,
      )
    )[0]!;
    expect(span.first >= '2021-09-01').toBe(true);
    expect(span.last).toBe('2026-09-15');
  });

  it('writes 1,033 intraday bars over the four captures that have a line', RETRY, async () => {
    await lockMarketTables(t);
    await seedBars(seedContext(t));

    const aapl = await instrumentOf(t, 'yahoo.chart', 'AAPL');
    const spx = await instrumentOf(t, 'yahoo.chart', '^GSPC');
    const ftse = await instrumentOf(t, 'yahoo.chart', '^FTSE');
    const eurusd = await instrumentOf(t, 'yahoo.chart', 'EURUSD=X');

    // The two AAPL minute captures of one request union to the later poll's 317 bars: the second
    // restates the 313 it shares with the first and inserts the four minutes that had not happened.
    expect(
      await count(t, 'bars_intraday', `instrument_id = ${String(aapl)} AND bar_interval = '1m'`),
    ).toBe(317);
    expect(
      await count(t, 'bars_intraday', `instrument_id = ${String(spx)} AND bar_interval = '5m'`),
    ).toBe(376);
    expect(
      await count(t, 'bars_intraday', `instrument_id = ${String(ftse)} AND bar_interval = '5m'`),
    ).toBe(103);
    expect(
      await count(t, 'bars_intraday', `instrument_id = ${String(eurusd)} AND bar_interval = '5m'`),
    ).toBe(237);

    // §18 counts `yahoo-bond`'s 75 `^TNX` bars; no row-5 instrument covers `^TNX`, so the capture
    // has no line to arrive on and the module reports a missing line instead of minting one.
    expect(
      await count(t, 'md_lines', `source_id = 'yahoo.chart' AND provider_symbol = '^TNX'`),
    ).toBe(0);
  });

  it('distributes the ECB fixing in both directions over a line it had to mint', RETRY, async () => {
    await lockMarketTables(t);
    await seedBars(seedContext(t));

    // §5.7: both directions of all 29 published currencies.
    expect(await count(t, 'fx_rates', `source_id = 'frankfurter' AND rate_date = '${SESSION}'`)).toBe(58);
    expect(
      await count(t, 'fx_rates', `source_id = 'frankfurter' AND base_ccy = 'USD' AND rate_date = '${SESSION}'`),
    ).toBe(29);

    // The nine `frankfurter` lines this module mints over the FX instruments `seed/universe.ts`
    // created — without them `jobs/fxEod.ts` reports `no_targets` and §18 row 8's `fx_rates` is empty.
    expect(await count(t, 'md_lines', `source_id = 'frankfurter' AND tx_to = 'infinity'`)).toBe(9);
    const eurusd = await instrumentOf(t, 'frankfurter', 'EURUSD');
    const bar = (
      await rows<{ open: string | null; close: string; session_date: string }>(
        t,
        `SELECT open::text AS open, close::text AS close, session_date::text AS session_date
           FROM bars_daily WHERE instrument_id = ${String(eurusd)} AND session_date = '${SESSION}'`,
      )
    )[0];
    expect(bar).toBeDefined();
    // §5.7: the ECB publishes a fixing, not a bar — only `close` is stated.
    expect(bar?.open).toBeNull();
    expect(Number(bar?.close)).toBeCloseTo(1 / 0.86663, 5);
  });

  it('mints the 3,510-contract chain once, with a quote and an OCC identifier each', RETRY, async () => {
    await lockMarketTables(t);
    await seedBars(seedContext(t));

    const aapl = await instrumentOf(t, 'cboe.options', CBOE_BACKFILL.options[0]!);
    expect(await count(t, 'option_terms', `underlying_instrument_id = ${String(aapl)} AND tx_to = 'infinity'`)).toBe(3510);
    expect(await count(t, 'option_quotes', `underlying_instrument_id = ${String(aapl)}`)).toBe(3510);
    expect(await count(t, 'identifiers', `scheme = 'OCC' AND tx_to = 'infinity' AND value LIKE 'AAPL%'`)).toBe(3510);
    // Every contract is an instrument of its own, and the chain hangs off the quoted underlying.
    expect(await count(t, 'instruments', `asset_class = 'option' AND tx_to = 'infinity'`)).toBe(3510);
    expect(aapl).toBe(await instrumentOf(t, 'cboe.quotes', 'AAPL'));
  });

  it('warm-starts exactly the four polled top-of-book subjects, close flagged as substituted', RETRY, async () => {
    await lockMarketTables(t);
    await seedBars(seedContext(t));

    const expected = [
      await instrumentOf(t, 'cboe.quotes', 'AAPL'),
      await instrumentOf(t, 'cboe.quotes', '_SPX'),
      await instrumentOf(t, 'cboe.quotes', '_VIX'),
      await instrumentOf(t, 'cboe.euIndices', 'BUK100P'),
    ].sort((a, b) => a - b);

    // `ORDER BY instrument_id` over a `::text AS instrument_id` alias sorts the *output* column, so
    // it would order 37367 before 85; the alias is different from the column name for that reason.
    const snapshots = await rows<{ id: string; subject: string; seq: string; state: unknown }>(
      t,
      'SELECT instrument_id::text AS id, subject, seq::text AS seq, state FROM quote_snapshots ORDER BY instrument_id',
    );
    expect(snapshots.map((s) => Number(s.id))).toEqual(expected);
    for (const snapshot of snapshots) {
      // `plant/warm.ts` skips a row whose state does not agree with its subject, so this is the
      // difference between a warm start and four silently dropped rows.
      expect(snapshot.subject).toBe(`q:${snapshot.id}`);
      const state = snapshot.state as { subject: string; instrumentId: number; seq: number; fields: Record<string, unknown> };
      expect(state.subject).toBe(snapshot.subject);
      expect(state.instrumentId).toBe(Number(snapshot.id));
      expect(state.seq).toBe(Number(snapshot.seq));
      expect(Number(state.fields.PX_LAST)).toBeGreaterThan(0);
    }
    // The option chain publishes a `q:` subject per ATM contract; none of them is warm-started.
    expect(snapshots).toHaveLength(4);

    const eod = await rows<{ id: string; session_date: string; fields: Record<string, unknown> }>(
      t,
      'SELECT instrument_id::text AS id, session_date::text AS session_date, fields FROM eod_snapshots ORDER BY instrument_id',
    );
    expect(eod.map((e) => Number(e.id))).toEqual(expected);

    // BUS-06 is about a SUBSTITUTED close, so the flag is asserted per subject rather than over all
    // four. This assertion used to read `expect(row.fields._flags).toEqual(['OFFICIAL_CLOSE_FROM_LAST'])`
    // for every row, and it passed only because the `seedBars` call above used to re-run the Cboe
    // legs and rewrite these rows from a plant it had just rebuilt. Once the legs became idempotent
    // the file read the rows the SEED left — which is the artefact it is supposed to be checking —
    // and BUK100P's row has no flag, correctly: `cboe-eu-indices` carries `"status": "C"` and
    // `"close": 1059.4557`, so the Cboe UK 100's close is PUBLISHED and nothing stood in for it. A
    // flag there would be the row claiming a substitution that did not happen.
    const buk100p = await instrumentOf(t, 'cboe.euIndices', 'BUK100P');
    for (const row of eod) {
      expect(row.session_date).toBe(SESSION);
      expect(Number(row.fields.PX_OFFICIAL_CLOSE)).toBeGreaterThan(0);
      if (Number(row.id) === buk100p) {
        // Asserted positively, so the absence of the flag is evidence and not a hole: the close in
        // the row is the close in the payload, to the digit.
        expect(row.fields._flags).toBeUndefined();
        expect(row.fields.PX_OFFICIAL_CLOSE).toBe(1059.4557);
      } else {
        // The three `cboe.quotes` captures were taken mid-session off the 15-minute delayed feed,
        // which publishes no official print, so the last trade stands in for the close and the row
        // says so.
        expect(row.fields._flags, `instrument ${row.id}`).toEqual(['OFFICIAL_CLOSE_FROM_LAST']);
      }
      // Only the six-field eod alphabet reaches the blob.
      for (const key of Object.keys(row.fields)) {
        expect(
          ['PX_OFFICIAL_CLOSE', 'PX_CLOSE_1D', 'PX_VOLUME', 'PX_OPEN', 'PX_HIGH', 'PX_LOW', '_flags'],
        ).toContain(key);
      }
    }
  });

  it('gives every written value a provenance row that resolves to a licensed source (DATA-10)', RETRY, async () => {
    await lockMarketTables(t);
    await seedBars(seedContext(t));

    for (const table of [
      'bars_daily',
      'bars_intraday',
      'fx_rates',
      'option_quotes',
      'quote_ticks',
      'eod_snapshots',
      'corporate_actions',
      'option_terms',
    ]) {
      expect(
        await count(
          t,
          table,
          `provenance_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM provenance p WHERE p.provenance_id = ${table}.provenance_id)`,
        ),
        `${table} rows with no resolvable provenance`,
      ).toBe(0);
    }
    // The capture behind a bar is the recorded one, so `captured_at` is inside the recording.
    expect(
      await count(
        t,
        'provenance',
        `source_id = 'yahoo.chart' AND captured_at::date <> '${SESSION}'`,
      ),
    ).toBe(0);
  });
});
