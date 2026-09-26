/**
 * Seed module 6 (DATA_MODEL §18 row 6) end to end off the replay store: the Treasury and
 * reference-rate master, the fixings, the H.15 series and the rate headline observations.
 *
 * Two things are asserted, and they are different things:
 *
 *  1. **the state** — the row counts and the specific values §18 row 6 and FUNCTIONS_TIER3 §0 L13
 *     fix. `test/globalSetup.ts` runs the whole seed before any integration file (TESTING §4.2 step
 *     5), so these hold over what the seed left; a module that wrote 14 govt securities instead of
 *     25, or lost the 10-year note's coupon, fails here.
 *  2. **idempotency** — the module is run again inside this test's transaction and every table delta
 *     must be zero. That is §18's acceptance row ("`db:seed` twice writes zero rows the second
 *     time") and it holds whether or not this file's run is the first one.
 *
 * Everything the run writes is rolled back with the test transaction (TESTING §4.3), so the file
 * leaves `bloomberg_test` exactly as `globalSetup` left it.
 */

import { describe, expect, it } from 'vitest';

import { parseCusip } from '@terminal/core/ids/cusip';

import { getConfig } from '../../../src/config.js';
import { RATES_TABLES, countTables, seedRates } from '../../../src/seed/rates.js';
import { frozenClock, TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { SeedContext } from '../../../src/seed/index.js';
import type { TestDb } from '../../../src/test/db.js';

/** See `test/integration/ingest/marketDataJobs.test.ts`: partition DDL in a sibling fork. */
const RETRY = { retry: 2 } as const;

/**
 * A `SeedContext` over the test's transaction.
 *
 * `db` is the harness's `Tx`, which is assignable to `SeedContext.db`'s `Db` (the two differ only in
 * `rollback()`); the seed modules cast it back to a transaction, the same cast
 * `ingest/scheduler.ts` L982 makes. The point of passing the harness's handle is that every write
 * rolls back.
 */
function seedContext(t: TestDb, log: string[]): SeedContext {
  return {
    query: (text, values) => t.client.query(text, values),
    db: t.db,
    config: getConfig(),
    clock: frozenClock(TEST_NOW),
    log: (message) => log.push(message),
  };
}

async function one<R extends Record<string, unknown>>(t: TestDb, sql: string): Promise<R> {
  const res = await t.client.query<R>(sql);
  const row = res.rows[0];
  if (row === undefined) throw new Error(`no row from: ${sql}`);
  return row;
}

async function count(t: TestDb, table: string, where = 'TRUE'): Promise<number> {
  const row = await one<{ n: string }>(t, `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`);
  return Number(row.n);
}

/** The seven curated on-the-run notes and bonds, as `fixtures/seed/treasuries.json` carries them. */
const CURATED: readonly { termLabel: string; cusip: string; ticker: string; coupon: string }[] = [
  { termLabel: '2Y', cusip: '91282CLV1', ticker: 'T 3.75 08/31/28', coupon: '3.750000' },
  { termLabel: '3Y', cusip: '91282CLX7', ticker: 'T 3.75 08/15/29', coupon: '3.750000' },
  { termLabel: '5Y', cusip: '91282CLW9', ticker: 'T 3.875 08/31/31', coupon: '3.875000' },
  { termLabel: '7Y', cusip: '91282CLY5', ticker: 'T 4.00 08/31/33', coupon: '4.000000' },
  { termLabel: '10Y', cusip: '91282CLN9', ticker: 'T 4.25 08/15/36', coupon: '4.250000' },
  { termLabel: '20Y', cusip: '912810UE6', ticker: 'T 4.50 08/15/46', coupon: '4.500000' },
  { termLabel: '30Y', cusip: '912810UF3', ticker: 'T 4.75 08/15/56', coupon: '4.750000' },
];

/**
 * The seven bills on the run on the **last** curve date the capture covers, 2026-09-14, read off
 * `treasury-bills.xml`: 4WK `912797VL8`, 6WK `912797UL9`, 8WK `912797VW4`, 13WK `912797VH7`,
 * 17WK `912797WP8`, 26WK `912797UD7`, 52WK `912797WA1`.
 *
 * FUNCTIONS_TIER3 §0 L13 and DATA_MODEL §18 row 6 both print a different seven —
 * `912797VE4 912797UK1 912797VN4 912797VA2 912797WH6 912797WD5 912797WA1` — and attribute them to
 * "the `treasury-bills.xml` 2026-09-14 row". That is the **2026-09-01** row: four of the seven
 * tenors rolled during the nine days the capture covers (the 4-week bill three times), and
 * `jobs/treasuryCurves.ts#onTheRunByLabel` correctly takes the CUSIP of the latest curve date per
 * term label. The fixture is the authority here and the documents are wrong; asserting the document
 * would mean asserting that the seed ignores a roll.
 */
const ON_THE_RUN_BILLS: readonly string[] = [
  '912797VL8',
  '912797UL9',
  '912797VW4',
  '912797VH7',
  '912797WP8',
  '912797UD7',
  '912797WA1',
];

describe('seed/rates writes the §18 row-6 master and nothing the second time', () => {
  const t = withTxDb();

  it('is idempotent by table delta', RETRY, async () => {
    const log: string[] = [];
    const ctx = seedContext(t, log);

    // Run once. In a normal suite `globalSetup` has already run the seed, so this writes nothing;
    // on a database where it has not, this is the run that writes the master. Either way the state
    // asserted below is the same, which is what makes the module idempotent rather than merely
    // re-runnable.
    await seedRates(ctx);

    const before = await countTables(t.db, RATES_TABLES);
    const deltas = await seedRates(ctx);
    const after = await countTables(t.db, RATES_TABLES);

    for (const table of RATES_TABLES) {
      expect(deltas[table], `${table} delta`).toBe(0);
      expect(after[table], `${table} count`).toBe(before[table]);
    }
  });

  it('mints 25 government securities: 18 bill CUSIPs and the 7 curated notes/bonds', RETRY, async () => {
    await seedRates(seedContext(t, []));

    // §18 row 6 says "14 govt instruments"; the capture names eighteen bill CUSIPs across its nine
    // curve dates (the weekly roll), and `jobs/treasuryCurves.ts#mintBillSecurities` mints every one
    // of them — an off-the-run bill still needs a security master row. 18 + 7 = 25.
    expect(await count(t, 'govt_terms', `tx_to = 'infinity'`)).toBe(25);
    expect(await count(t, 'govt_terms', `tx_to = 'infinity' AND security_type = 'bill'`)).toBe(18);
    expect(await count(t, 'govt_terms', `tx_to = 'infinity' AND security_type IN ('note','bond')`)).toBe(7);

    // Exactly one bill per term label is on the run — the roll rule of §9.2.
    const labels = await t.client.query<{ term_label: string; n: string }>(
      `SELECT term_label, count(*)::text AS n FROM govt_terms
        WHERE tx_to = 'infinity' AND security_type = 'bill' AND on_the_run
        GROUP BY term_label ORDER BY term_label`,
    );
    expect(labels.rows.map((r) => Number(r.n))).toEqual([1, 1, 1, 1, 1, 1, 1]);
    const onTheRun = await t.client.query<{ cusip: string }>(
      `SELECT cusip FROM govt_terms
        WHERE tx_to = 'infinity' AND security_type = 'bill' AND on_the_run ORDER BY cusip`,
    );
    expect(onTheRun.rows.map((r) => r.cusip.trim()).sort()).toEqual([...ON_THE_RUN_BILLS].sort());
  });

  it('gives every curated note the terms, ticker and identifier the documents fix', RETRY, async () => {
    await seedRates(seedContext(t, []));

    for (const wanted of CURATED) {
      const row = await one<{
        cusip: string;
        ticker: string;
        coupon_rate: string;
        coupon_freq: number;
        day_count: string;
        calendar_id: string;
        settlement_days: number;
        on_the_run: boolean;
        security_type: string;
        asset_class: string;
        market_sector: string;
        exch_code: string;
        provenance_id: string;
      }>(
        t,
        `SELECT g.cusip, i.ticker, g.coupon_rate::text AS coupon_rate, g.coupon_freq, g.day_count,
                g.calendar_id, g.settlement_days, g.on_the_run, g.security_type,
                i.asset_class::text AS asset_class, i.market_sector::text AS market_sector,
                i.exch_code, g.provenance_id::text AS provenance_id
           FROM govt_terms g
           JOIN instruments i ON i.instrument_id = g.instrument_id AND i.tx_to = 'infinity'
          WHERE g.tx_to = 'infinity' AND g.cusip = '${wanted.cusip}'`,
      );
      expect(row.ticker).toBe(wanted.ticker);
      expect(row.coupon_rate).toBe(wanted.coupon);
      // FUNCTIONS_TIER3 §0 L13: coupon_freq 2, ACT/ACT, SIFMA, settlement_days 1, on_the_run.
      expect(row.coupon_freq).toBe(2);
      expect(row.day_count).toBe('ACT/ACT');
      expect(row.calendar_id).toBe('SIFMA');
      expect(row.settlement_days).toBe(1);
      expect(row.on_the_run).toBe(true);
      expect(row.asset_class).toBe('govt');
      expect(row.market_sector).toBe('Govt');
      expect(row.exch_code).toBe('GOVT');
      // DATA-10: the value cites the curated file, not nothing.
      expect(Number(row.provenance_id)).toBeGreaterThan(0);

      // REF-02: the CUSIP resolves, which it only can because the check digit is valid.
      expect(parseCusip(wanted.cusip).ok).toBe(true);
      expect(
        await count(
          t,
          'identifiers',
          `scheme = 'CUSIP' AND value = '${wanted.cusip}' AND entity_kind = 'instrument' AND tx_to = 'infinity'`,
        ),
      ).toBe(1);
    }
  });

  it('attributes the curated notes to one `internal.user` provenance row over the file', RETRY, async () => {
    await seedRates(seedContext(t, []));

    const row = await one<{ n: string; source_id: string; request_key: string; status: string }>(
      t,
      `SELECT count(*)::text AS n, min(p.source_id) AS source_id, min(p.request_key) AS request_key,
              min(p.http_status)::text AS status
         FROM govt_terms g
         JOIN provenance p ON p.provenance_id = g.provenance_id
        WHERE g.tx_to = 'infinity' AND g.security_type IN ('note','bond')`,
    );
    expect(Number(row.n)).toBe(7);
    // One row for the file, re-used by all seven securities and by a second run (nothing was
    // fetched, so nothing was observed twice).
    expect(row.source_id).toBe('internal.user');
    expect(row.request_key).toBe('seed:treasuries.json');
    expect(
      await count(t, 'provenance', `request_key = 'seed:treasuries.json'`),
    ).toBe(1);
  });

  it('mints the six rate instruments with terms, a line and a two-way econ series link', RETRY, async () => {
    await seedRates(seedContext(t, []));

    const rows = await t.client.query<{
      rate_code: string;
      ticker: string;
      market_sector: string;
      exch_code: string;
      day_count: string;
      compounding: string;
      publication_time_et: string;
      series_code: string;
      series_instrument: string | null;
      line_symbol: string;
      delay: number;
    }>(
      `SELECT r.rate_code, i.ticker, i.market_sector::text AS market_sector, i.exch_code,
              r.day_count, r.compounding, r.publication_time_et::text AS publication_time_et,
              s.series_code, s.instrument_id::text AS series_instrument,
              m.provider_symbol AS line_symbol, m.intrinsic_delay_min AS delay
         FROM rate_terms r
         JOIN instruments i ON i.instrument_id = r.instrument_id AND i.tx_to = 'infinity'
         JOIN econ_series s ON s.series_id = r.series_id
         JOIN md_lines m ON m.instrument_id = r.instrument_id AND m.tx_to = 'infinity'
        WHERE r.tx_to = 'infinity' ORDER BY r.rate_code`,
    );
    expect(rows.rows.map((r) => r.rate_code)).toEqual([
      'BGCR',
      'EFFR',
      'OBFR',
      'SOFR',
      'SOFRAI',
      'TGCR',
    ]);
    for (const row of rows.rows) {
      // `'SOFR Index'` is the command-line key: ticker + synthetic exch code + sector.
      expect(row.ticker).toBe(row.rate_code);
      expect(row.market_sector).toBe('Index');
      expect(row.exch_code).toBe('RATE');
      expect(row.day_count).toBe('ACT/360');
      // The NY Fed publishes a final fixing, not a delayed quote.
      expect(row.delay).toBe(0);
      // The md line is keyed by the rate code itself, which is what makes the parser publish `r:`.
      expect(row.line_symbol).toBe(row.rate_code);
      expect(row.series_code).toBe(row.rate_code);
      expect(Number(row.series_instrument)).toBeGreaterThan(0);
    }
    // SOFRAI is the averages/index release, not an overnight fixing.
    expect(rows.rows.find((r) => r.rate_code === 'SOFRAI')?.compounding).toBe('index');
    expect(rows.rows.filter((r) => r.compounding === 'simple')).toHaveLength(5);
  });

  it('writes the fixings, the 11 H.15 series and the rate headlines, all with provenance', RETRY, async () => {
    await seedRates(seedContext(t, []));

    // §18 row 6: `rate_fixings ≈ 30`. The three recorded NY Fed captures publish nineteen distinct
    // (rate_code, effective_date) pairs: EFFR's ten days, SOFR's five, and one each for OBFR, TGCR,
    // BGCR and SOFRAI from `/all/latest.json`.
    expect(await count(t, 'rate_fixings')).toBe(19);
    expect(await count(t, 'rate_fixings', `rate_code = 'EFFR'`)).toBe(10);
    expect(await count(t, 'rate_fixings', `rate_code = 'SOFR'`)).toBe(5);
    // SOFRAI publishes no percentRate; the column stays NULL rather than becoming a zero.
    expect(await count(t, 'rate_fixings', `rate_code = 'SOFRAI' AND rate IS NULL`)).toBe(1);

    // 6 rate series + 11 H.15 constant maturities (§18 row 6).
    expect(await count(t, 'econ_series', `source_id = 'nyfed.rates'`)).toBe(6);
    expect(await count(t, 'econ_series', `source_id = 'fed.h15'`)).toBe(11);

    // The headline of every fixing that has one — SOFRAI's NULL rate is not an observation.
    expect(await count(t, 'econ_observations', `series_id IN (SELECT series_id FROM econ_series WHERE source_id = 'nyfed.rates')`)).toBe(18);
    // H.15: five published rows × eleven series, one of which (2026-09-07) is `ND` in every column.
    expect(await count(t, 'econ_observations', `series_id IN (SELECT series_id FROM econ_series WHERE source_id = 'fed.h15')`)).toBe(55);
    // 2026-09-07 is `ND` in all eleven H.15 columns: a missing observation, never a zero.
    expect(
      await count(
        t,
        'econ_observations',
        `status = 'missing' AND value IS NULL AND obs_date = '2026-09-07'
           AND series_id IN (SELECT series_id FROM econ_series WHERE source_id = 'fed.h15')`,
      ),
    ).toBe(11);

    // DATA-10, the rule this package exists to demonstrate: not one value row without a provenance
    // row, and not one provenance row citing a source the registry does not know.
    for (const table of ['govt_terms', 'rate_terms', 'rate_fixings', 'econ_observations', 'curve_points']) {
      expect(
        await count(
          t,
          table,
          `provenance_id IS NULL OR NOT EXISTS (SELECT 1 FROM provenance p WHERE p.provenance_id = ${table}.provenance_id)`,
        ),
        `${table} rows with no resolvable provenance`,
      ).toBe(0);
    }
    expect(
      await count(
        t,
        'provenance p',
        `NOT EXISTS (SELECT 1 FROM licence_registry l WHERE l.source_id = p.source_id AND l.tx_to = 'infinity')`,
      ),
    ).toBe(0);
  });

  it('writes the par, bill and CMT curve points the fixtures carry', RETRY, async () => {
    await seedRates(seedContext(t, []));

    // §18 row 7's ≈300 published points, which module 6's two jobs are what actually write:
    // 9 curve dates × 14 par tenors, 9 × 7 bill tenors × 2 quote types, H.15's 4 published days ×
    // 11 constant maturities, and the five SOFR fixings.
    expect(await count(t, 'curve_points', `curve_id = 'UST_PAR'`)).toBe(126);
    expect(await count(t, 'curve_points', `curve_id = 'UST_BILL' AND quote_type = 'discount_rate'`)).toBe(63);
    expect(await count(t, 'curve_points', `curve_id = 'UST_BILL' AND quote_type = 'investment_yield'`)).toBe(63);
    expect(await count(t, 'curve_points', `curve_id = 'UST_CMT'`)).toBe(44);
    expect(await count(t, 'curve_points', `curve_id = 'SOFR_FIX'`)).toBe(5);

    // The latest dates FUNCTIONS_TIER3 §0 L11 pins for this fixture set.
    const latest = await one<{ par: string; cmt: string; fix: string }>(
      t,
      `SELECT max(curve_date) FILTER (WHERE curve_id = 'UST_PAR')::text AS par,
              max(curve_date) FILTER (WHERE curve_id = 'UST_CMT')::text AS cmt,
              max(curve_date) FILTER (WHERE curve_id = 'SOFR_FIX')::text AS fix
         FROM curve_points`,
    );
    expect(latest.par).toBe('2026-09-14');
    expect(latest.cmt).toBe('2026-09-11');
    expect(latest.fix).toBe('2026-09-14');

    // The 10-year par yield the YAS golden prices at (FUNCTIONS_TIER3 §0 L71).
    const tenY = await one<{ value: string }>(
      t,
      `SELECT value::text AS value FROM curve_points
        WHERE curve_id = 'UST_PAR' AND curve_date = '2026-09-14' AND tenor = '10Y' AND is_latest`,
    );
    expect(Number(tenY.value)).toBeCloseTo(4.97, 8);
  });
});
