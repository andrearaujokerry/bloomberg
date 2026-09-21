/**
 * `data/historical.ts` — WORKPLAN §WP-04 acceptance row 7: `unadjusted` / `price` / `total_return`
 * series across the AAPL 4:1 split of 2020-08-31, and every row carrying a `provenance_id`.
 *
 * The window is the one API.md §12.1 L1414-1433 pins — closes 2020-08-27 500.04, 08-28 499.23,
 * 08-31 129.04, 09-01 134.18, the split *recorded* on 2020-07-31 — extended by two sessions so the
 * three policies can be told apart:
 *
 *  - a lead-in print on 2020-08-25, which is outside every requested window and exists so that a
 *    read starting on 2020-08-28 still has the session before it (DATA_MODEL §6.1);
 *  - a synthetic cash dividend going ex on 2020-08-28 of **5.0004**, chosen so its factor is
 *    exactly `1 − 5.0004 / 500.04 = 0.99` against the unadjusted close of 2020-08-27. A round
 *    factor is what makes "price and total_return differ, and differ by this much" an assertion
 *    rather than a tolerance. AAPL's real August 2020 dividend went ex on 08-07, outside every
 *    window here, so it could not do this job.
 *
 * Everything is built in the test's own rolled-back transaction: WP-15 owns the seed modules and
 * they do not exist yet, so nothing here may assume a seeded database (TESTING §4.3).
 */

import { describe, expect, it } from 'vitest';

import { historicalService } from '../../../src/data/historical.js';
import { ProvenanceIndex } from '../../../src/data/reference.js';
import { recordAction } from '../../../src/refdata/corporateActions.js';
import { masterRepositories } from '../../../src/refdata/master.js';
import { withTxDb } from '../../../src/test/db.js';

import type { FieldId } from '@terminal/core';
import type { HistorySeries } from '../../../src/data/historical.js';
import type { TestDb } from '../../../src/test/db.js';

// ── The fixture window ───────────────────────────────────────────────────────────────────────

/** session → unadjusted close. 2020-08-25 is the lead-in; no requested window includes it. */
const CLOSES: readonly (readonly [string, number])[] = [
  ['2020-08-25', 497.48],
  ['2020-08-26', 506.09],
  ['2020-08-27', 500.04],
  ['2020-08-28', 499.23],
  ['2020-08-31', 129.04],
  ['2020-09-01', 134.18],
];
const VOLUME = 1_000_000;

const SPLIT_EX = '2020-08-31';
const DIV_EX = '2020-08-28';
/** `1 − 5.0004 / 500.04 = 0.99` exactly, against the unadjusted close of 2020-08-27. */
const DIV_AMOUNT = 5.0004;
const DIV_FACTOR = 0.99;
const SPLIT_FACTOR = 0.25;

/** The instants we came to know each action (`tx_from`), not the dates it happened on. */
const SPLIT_KNOWN = new Date('2020-07-31T12:00:00Z');
const DIV_KNOWN = new Date('2020-07-31T12:00:00Z');
/** Before either was recorded: the world in which neither action exists (REF-03). */
const BEFORE_KNOWN = new Date('2020-07-30T00:00:00Z');

const NOW = new Date('2026-09-15T00:00:00Z');
const ASOF_NOW = { validAt: NOW, knownAt: NOW };
/** The master rows are known from long before every read in this file. */
const MASTER_KNOWN = new Date('2000-01-01T00:00:00Z');

interface Fixture {
  instrumentId: number;
  barProvenanceId: number;
  provenance: (sourceId: string, label: string) => Promise<number>;
}

async function fixture(t: TestDb): Promise<Fixture> {
  for (const [sourceId, name] of [
    ['yahoo.chart', 'Yahoo Finance chart v8'],
    ['internal.user', 'Internal / user supplied'],
  ] as const) {
    await t.client.query(
      `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, attribution,
                                     rate_limit, valid_from)
       SELECT $1, $2, 'Test', 'internal', $2, 'n/a', timestamptz '2000-01-01'
        WHERE NOT EXISTS (SELECT 1 FROM licence_registry
                           WHERE source_id = $1 AND tx_to = 'infinity')`,
      [sourceId, name],
    );
  }

  let seq = 0;
  const provenance = async (sourceId: string, label: string): Promise<number> => {
    seq += 1;
    const key = `hist-${label}-${String(seq)}-${String(Math.random()).slice(2)}`;
    const res = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ($1, $2, 'test://historical/' || $2, digest($2, 'sha256'), digest($2, 'sha256'),
               200, 0, timestamptz '2026-09-14T20:10:00Z', 'test/1.0.0')
       RETURNING provenance_id`,
      [sourceId, key],
    );
    return Number(res.rows[0]!.provenance_id);
  };

  // The master row: `data/historical.ts` reads the quote currency off it, so the series cannot be
  // built without one. `issue_id` is a key from the sequence — this file exercises the bar reader,
  // not the issue hierarchy.
  const issueIds = await t.client.query<{ issue_id: string }>(
    `SELECT nextval('issue_id_seq')::bigint AS issue_id`,
  );
  const masterProvenance = await provenance('internal.user', 'master');
  const instrumentId = await masterRepositories(t.db).instruments.insert(
    {
      issueId: Number(issueIds.rows[0]!.issue_id),
      assetClass: 'equity',
      marketSector: 'Equity',
      ticker: 'AAPL',
      exchCode: 'US',
      name: 'Apple Inc',
      currency: 'USD',
    },
    {
      validFrom: new Date('1980-12-12T00:00:00Z'),
      provenanceId: masterProvenance,
      knownAt: MASTER_KNOWN,
    },
  );

  const mdLines = await t.client.query<{ md_line_id: string }>(
    `SELECT nextval('md_line_id_seq')::bigint AS md_line_id`,
  );
  const mdLineId = Number(mdLines.rows[0]!.md_line_id);

  // `bars_daily` is ALWAYS unadjusted (DATA_MODEL §7.2): these are the prints as published.
  const barProvenanceId = await provenance('yahoo.chart', 'bars');
  for (const [date, close] of CLOSES) {
    await t.client.query(
      `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                               volume, capture_ts, provenance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $4, $7, timestamptz '2026-09-14T20:10:00Z', $8)`,
      [instrumentId, date, mdLineId, close, close + 1, close - 1, VOLUME, barProvenanceId],
    );
  }

  return { instrumentId, barProvenanceId, provenance };
}

/** The 4:1 split, recorded 2020-07-31, `review_state 'auto'` (a machine-clean feed row). */
async function recordSplit(t: TestDb, f: Fixture): Promise<void> {
  await recordAction(t.db, {
    instrumentId: f.instrumentId,
    caType: 'split',
    status: 'paid',
    declaredDate: '2020-07-30',
    exDate: SPLIT_EX,
    ratioNew: 4,
    ratioOld: 1,
    sourceId: 'yahoo.chart',
    reviewState: 'auto',
    provenanceId: await f.provenance('yahoo.chart', 'split'),
    txFrom: SPLIT_KNOWN,
  });
}

/** The cash dividend going ex on the 28th — the only difference between price and total_return. */
async function recordDividend(t: TestDb, f: Fixture): Promise<void> {
  await recordAction(t.db, {
    instrumentId: f.instrumentId,
    caType: 'cash_dividend',
    status: 'paid',
    declaredDate: '2020-07-30',
    exDate: DIV_EX,
    amount: DIV_AMOUNT,
    currency: 'USD',
    sourceId: 'yahoo.chart',
    reviewState: 'auto',
    provenanceId: await f.provenance('yahoo.chart', 'dividend'),
    txFrom: DIV_KNOWN,
  });
}

/** One column of a block, by field id. */
function column(block: HistorySeries, field: FieldId): (number | null)[] {
  const j = block.columns.indexOf(field);
  if (j === -1) throw new Error(`no column ${field} in [${block.columns.join(', ')}]`);
  return block.rows.map((row) => row[j] ?? null);
}

function round(values: (number | null)[], dp = 6): (number | null)[] {
  return values.map((v) => (v === null ? null : Number(v.toFixed(dp))));
}

const FIELDS: FieldId[] = ['PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME'];

describe('adjust-on-read across the 2020-08-31 4:1 split (REF-09)', () => {
  const t = withTxDb();

  /** Build the fixture, record both actions, and return the three series over one window. */
  async function threeSeries(
    start = '2020-08-26',
    end = '2020-09-01',
  ): Promise<{
    prov: ProvenanceIndex;
    unadjusted: HistorySeries;
    price: HistorySeries;
    totalReturn: HistorySeries;
  }> {
    const f = await fixture(t);
    await recordSplit(t, f);
    await recordDividend(t, f);
    const prov = new ProvenanceIndex();
    const service = historicalService({ tx: t.db, asOf: ASOF_NOW, prov });
    const q = { start, end, periodicity: 'D' as const, fields: FIELDS };
    return {
      prov,
      unadjusted: await service.bars(f.instrumentId, { ...q, adjust: 'unadjusted' }),
      price: await service.bars(f.instrumentId, { ...q, adjust: 'price' }),
      totalReturn: await service.bars(f.instrumentId, { ...q, adjust: 'total_return' }),
    };
  }

  it('returns the stored prints, and nothing else, under unadjusted', async () => {
    const { unadjusted } = await threeSeries();

    // The requested window exactly: the lead-in session the read loads for the factors is gone.
    expect(unadjusted.index).toEqual([
      '2020-08-26',
      '2020-08-27',
      '2020-08-28',
      '2020-08-31',
      '2020-09-01',
    ]);
    expect(column(unadjusted, 'PX_LAST')).toEqual([506.09, 500.04, 499.23, 129.04, 134.18]);
    expect(column(unadjusted, 'PX_HIGH')).toEqual([507.09, 501.04, 500.23, 130.04, 135.18]);
    expect(column(unadjusted, 'PX_VOLUME')).toEqual(new Array(5).fill(VOLUME));
    expect(unadjusted.adjust).toBe('unadjusted');
    expect(unadjusted.adjustments).toEqual([]);
    expect(unadjusted.currency).toBe('USD');
  });

  it('applies the ratio action, and only that, under price', async () => {
    const { price } = await threeSeries();

    expect(price.adjustments).toEqual([
      { beforeDate: SPLIT_EX, priceFactor: SPLIT_FACTOR, volumeFactor: 4, kind: 'split' },
    ]);
    expect(round(column(price, 'PX_LAST'))).toEqual([
      126.5225, // 506.09 × 0.25
      125.01, // 500.04 × 0.25
      124.8075, // 499.23 × 0.25 — the number API.md §12.1 states
      129.04, // on or after the ex-date: untouched
      134.18,
    ]);
    expect(round(column(price, 'PX_HIGH'))).toEqual([126.7725, 125.26, 125.0575, 130.04, 135.18]);
    // Volume moves the other way: four times as many shares for the same money.
    expect(column(price, 'PX_VOLUME')).toEqual([4_000_000, 4_000_000, 4_000_000, VOLUME, VOLUME]);
  });

  it('applies the cash action as well under total_return', async () => {
    const { totalReturn } = await threeSeries();

    // Ascending by `beforeDate`: the dividend first, then the split.
    expect(totalReturn.adjustments).toEqual([
      { beforeDate: DIV_EX, priceFactor: DIV_FACTOR, volumeFactor: 1, kind: 'dividend' },
      { beforeDate: SPLIT_EX, priceFactor: SPLIT_FACTOR, volumeFactor: 4, kind: 'split' },
    ]);
    expect(round(column(totalReturn, 'PX_LAST'))).toEqual([
      Number((506.09 * DIV_FACTOR * SPLIT_FACTOR).toFixed(6)), // both steps are after 08-26
      Number((500.04 * DIV_FACTOR * SPLIT_FACTOR).toFixed(6)), // both steps are after 08-27
      124.8075, // the dividend's own ex-date is not "after" it: split only
      129.04,
      134.18,
    ]);
    // A cash action carries no volume factor, so volumes match the `price` reading.
    expect(column(totalReturn, 'PX_VOLUME')).toEqual([
      4_000_000,
      4_000_000,
      4_000_000,
      VOLUME,
      VOLUME,
    ]);
  });

  it('the three readings differ exactly where the actions are, and nowhere else', async () => {
    const { unadjusted, price, totalReturn } = await threeSeries();
    const u = column(unadjusted, 'PX_LAST');
    const p = column(price, 'PX_LAST');
    const tr = column(totalReturn, 'PX_LAST');

    expect(unadjusted.index).toEqual(price.index);
    expect(price.index).toEqual(totalReturn.index);

    // Before the split: unadjusted is four times the adjusted reading.
    for (const i of [0, 1, 2]) {
      expect(p[i]).not.toBe(u[i]);
      expect(p[i]! / u[i]!).toBeCloseTo(SPLIT_FACTOR, 12);
    }
    // On and after the ex-date: nothing to adjust, so all three agree.
    for (const i of [3, 4]) {
      expect(p[i]).toBe(u[i]);
      expect(tr[i]).toBe(u[i]);
    }
    // total_return differs from price only before the dividend's ex-date, and by its factor.
    for (const i of [0, 1]) {
      expect(tr[i]).not.toBe(p[i]);
      expect(tr[i]! / p[i]!).toBeCloseTo(DIV_FACTOR, 12);
    }
    expect(tr[2]).toBe(p[2]);
  });

  it('carries a provenance_id on every row of every reading (DATA-10)', async () => {
    const { prov, unadjusted, price, totalReturn } = await threeSeries();

    for (const block of [unadjusted, price, totalReturn]) {
      expect(block.rowProvenanceIds).toHaveLength(block.index.length);
      expect(block.rowProvIdx).toHaveLength(block.index.length);
      for (const provenanceId of block.rowProvenanceIds) {
        expect(provenanceId).toBeGreaterThan(0);
        // The id is registered, and `provIdxOf` maps it to the index the row cites.
        expect(block.provIdxOf[provenanceId]).toBeGreaterThanOrEqual(0);
      }
      for (const idx of block.rowProvIdx) expect(block.provIdx).toContain(idx);
    }

    // The adjusted readings additionally cite the corporate actions that moved the prices, so
    // `meta.provenance[]` can attribute the adjustment as well as the bar.
    expect(unadjusted.provIdx.length).toBe(1);
    expect(price.provIdx.length).toBe(2);
    expect(totalReturn.provIdx.length).toBe(3);

    const listed = prov.list();
    expect(listed).toHaveLength(3);
    for (const entry of listed) {
      expect(entry.sourceId).toBe('yahoo.chart');
      expect(entry.capturedAt).toBe('2026-09-14T20:10:00.000Z');
      // Attribution belongs to the runner and its licence registry, not to a data service.
      expect(entry.attribution).toBe('');
    }
    // A completed session's close is closed, not stale.
    expect(prov.worstState()).toBe('closed');
  });

  it('does not apply an action recorded after knownAt (REF-03)', async () => {
    const f = await fixture(t);
    await recordSplit(t, f);
    await recordDividend(t, f);

    const service = historicalService({
      tx: t.db,
      asOf: { validAt: NOW, knownAt: BEFORE_KNOWN },
      prov: new ProvenanceIndex(),
    });
    const block = await service.bars(f.instrumentId, {
      start: '2020-08-26',
      end: '2020-09-01',
      periodicity: 'D',
      adjust: 'total_return',
      fields: ['PX_LAST'],
    });

    expect(block.adjustments).toEqual([]);
    expect(column(block, 'PX_LAST')).toEqual([506.09, 500.04, 499.23, 129.04, 134.18]);
  });

  it('loads the session before the window so the total-return chain has its first link', async () => {
    const f = await fixture(t);
    await recordSplit(t, f);
    await recordDividend(t, f);

    const service = historicalService({
      tx: t.db,
      asOf: ASOF_NOW,
      prov: new ProvenanceIndex(),
    });
    // The window starts ON the dividend's ex-date, so the close it is measured against —
    // 2020-08-27 — lies outside the window and can only come from the lead-in load.
    const block = await service.bars(f.instrumentId, {
      start: DIV_EX,
      end: '2020-09-01',
      periodicity: 'D',
      adjust: 'total_return',
      fields: ['PX_LAST', 'TOT_RETURN_INDEX'],
    });

    expect(block.index).toEqual(['2020-08-28', '2020-08-31', '2020-09-01']);
    const tr = column(block, 'TOT_RETURN_INDEX');

    // TR_t = TR_{t−1} × (P_t + D_t) / P_{t−1} on the split basis, based at the prior close.
    const priorClose = 500.04; // 2020-08-27, the lead-in session
    const basis = SPLIT_FACTOR; // both sessions sit before the split
    const expected = priorClose * ((499.23 * basis + DIV_AMOUNT * basis) / (priorClose * basis));
    expect(tr[0]!).toBeCloseTo(expected, 8);
    // Without the lead-in the chain would have started at the window's own first close.
    expect(tr[0]!).toBeGreaterThan(priorClose);
    expect(tr[0]!).not.toBeCloseTo(499.23, 6);
  });

  it('resamples to monthly buckets labelled by the last session of each period', async () => {
    const f = await fixture(t);
    await recordSplit(t, f);
    const service = historicalService({
      tx: t.db,
      asOf: ASOF_NOW,
      prov: new ProvenanceIndex(),
    });
    const monthly = await service.bars(f.instrumentId, {
      start: '2020-08-26',
      end: '2020-09-01',
      periodicity: 'M',
      adjust: 'unadjusted',
      fields: FIELDS,
    });

    expect(monthly.index).toEqual(['2020-08-31', '2020-09-01']);
    // First open, highest high, lowest low, last close, summed volume.
    expect(column(monthly, 'PX_OPEN')).toEqual([506.09, 134.18]);
    expect(column(monthly, 'PX_HIGH')).toEqual([507.09, 135.18]);
    expect(column(monthly, 'PX_LOW')).toEqual([128.04, 133.18]);
    expect(column(monthly, 'PX_LAST')).toEqual([129.04, 134.18]);
    expect(column(monthly, 'PX_VOLUME')).toEqual([4 * VOLUME, VOLUME]);
  });
});
