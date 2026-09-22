/**
 * `treasury.bills` — QA-02: `parse.ts` over `raw/treasury-bills.xml` equals the committed golden
 * `fixtures/providers/normalised/treasury-bills.xml.json`, byte for byte.
 *
 * Measured from the capture, every number below:
 *
 *  - **9 entries × 7 tenors = 63 bill rows and 126 curve points** (a discount rate and an
 *    investment yield for each), over the same nine business days as the par curve;
 *  - **18 distinct CUSIPs**, because the on-the-run bill rolls inside the month: `4WK` runs
 *    `912797VE4 → 912797VK0 → 912797VL8` and `13WK` runs `912797VA2 → 912797VH7`. Every roll moves
 *    the maturity date forward, so the capture yields **no `source_conflict`** — which is the
 *    check that would catch a Treasury data-entry correction;
 *  - **the investment yield is above the discount rate on all 63 rows**, so no transposed pair is
 *    dropped;
 *  - **`BOND_MKT_UNAVAIL_REASON` is empty on all nine entries**, so nothing is skipped;
 *  - **60 of 126 values disagree with their `CS_*_AVG` cross-check**, by 1 bp to 11 bp, on six of
 *    the nine days. PROVIDERS §9.2 states they are identical on every recorded row; they are not,
 *    and the parser does what §9.2 prescribes for a divergence — it publishes the `ROUND_B1_*`
 *    value and records the mismatch for the job to raise. The count is pinned here so that the
 *    integrator's choice (a tolerance on the monitor, or a correction to §9.2) is a decision
 *    against a measurement rather than against a sentence.
 *
 * `md_lines` for this source are keyed by the **tenor label**, not by the CUSIP, so the seven
 * canonical lines below produce seven `q:<instrumentId>` updates carrying the last published day.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import {
  BILL_RATES_DATASET,
  registerTreasuryAdapters,
  treasuryBillsAdapter,
  treasuryUrl,
} from '../../../src/providers/treasury/adapter.js';
import { BILL_TENORS, parseBillRates } from '../../../src/providers/treasury/parse.js';
import { readGolden, serialiseGolden, toGolden } from './golden.js';
import type { NormaliseContext, NormaliseLine } from '../../../src/providers/types.js';

const store = openReplayStore();

const URL = treasuryUrl(BILL_RATES_DATASET, '202609');
const raw = store.replay({ providerId: 'treasury.bills', url: URL });

/**
 * The canonical context — seven `md_lines` rows, one per tenor label, exactly as PROVIDERS §9.2
 * describes them (`line_kind 'reference'`, `expected_interval_ms` one day, `priority 30`). WP-15
 * owns the seed and does not exist yet, so the lines are built here.
 */
const BILL_LINES = new Map<string, NormaliseLine>(
  (['4WK', '6WK', '8WK', '13WK', '17WK', '26WK', '52WK'] as const).map((label, index) => [
    label,
    {
      mdLineId: 9201 + index,
      instrumentId: 8201 + index,
      assetClass: 'govt',
      tier: 'eod',
      intrinsicDelayMin: 0,
      expectedIntervalMs: 86_400_000,
      priority: 30,
    },
  ]),
);

const ctx: NormaliseContext = { provenanceId: 1, capturedAt: raw.capturedAt, lines: BILL_LINES };
const parsed = parseBillRates(raw, ctx);
const { bills, curvePoints, crossChecks, conflicts, unavailable } = parsed.rows;

describe('treasury.bills replay', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.providerId).toBe('treasury.bills');
    expect(raw.status).toBe(200);
    expect(raw.requestKey).toBe(requestKey('treasury.bills', 'GET', URL));
    expect(raw.sha256).toBe('2ea165629c3d51674eff1008416a36bb3e216987f643afd447362fff4fcaf9c1');
    expect(raw.body.byteLength).toBe(35_556);
  });

  it('matches the committed golden exactly', () => {
    const golden = serialiseGolden(
      toGolden(
        'treasury-bills.xml',
        treasuryBillsAdapter.id,
        raw.requestKey,
        treasuryBillsAdapter.adapterVersion,
        parsed,
      ),
    );
    expect(golden).toBe(readGolden('treasury-bills.xml.json'));
  });

  it('publishes 63 bills and 126 curve points over nine business days', () => {
    expect(bills).toHaveLength(63);
    expect(curvePoints).toHaveLength(126);
    expect(unavailable).toEqual([]);
    expect(conflicts).toEqual([]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sourceTs?.toISOString()).toBe('2026-09-15T02:01:31.000Z');
    const dates = [...new Set(bills.map((b) => b.curveDate))];
    expect(dates).toHaveLength(9);
    expect(dates[0]).toBe('2026-09-01');
    expect(dates[8]).toBe('2026-09-14');
    expect(new Set(curvePoints.map((p) => p.quoteType))).toEqual(
      new Set(['discount_rate', 'investment_yield']),
    );
    expect(BILL_TENORS.map((t) => t.tenorDays)).toEqual([28, 42, 56, 91, 119, 182, 364]);
  });

  it('carries a CUSIP and a maturity on every row, and rolls the on-the-run bill', () => {
    expect(bills.every((b) => b.cusip !== null && /^[0-9A-Z]{9}$/.test(b.cusip))).toBe(true);
    expect(bills.every((b) => b.maturityDate !== null)).toBe(true);
    expect(new Set(bills.map((b) => b.cusip)).size).toBe(18);
    const fourWeek = bills.filter((b) => b.termLabel === '4WK');
    expect([...new Set(fourWeek.map((b) => b.cusip))]).toEqual([
      '912797VE4',
      '912797VK0',
      '912797VL8',
    ]);
    // Every roll moves the maturity forward — that is why `conflicts` is empty.
    const maturities = fourWeek.map((b) => b.maturityDate ?? '');
    expect([...maturities].sort()).toEqual(maturities);
  });

  it('keeps the discount rate below the investment yield on every row', () => {
    for (const bill of bills) {
      expect(bill.discountRate).not.toBeNull();
      expect(bill.investmentYield).not.toBeNull();
      expect(bill.discountRate ?? 0).toBeLessThan(bill.investmentYield ?? 0);
    }
    const thirteen = bills.filter((b) => b.termLabel === '13WK');
    expect(thirteen[0]).toEqual({
      curveDate: '2026-09-01',
      termLabel: '13WK',
      tenorDays: 91,
      cusip: '912797VA2',
      maturityDate: '2026-12-03',
      discountRate: 3.78,
      investmentYield: 3.87,
    });
    expect(thirteen[thirteen.length - 1]).toEqual({
      curveDate: '2026-09-14',
      termLabel: '13WK',
      tenorDays: 91,
      cusip: '912797VH7',
      maturityDate: '2026-12-17',
      discountRate: 3.97,
      investmentYield: 4.07,
    });
  });

  it('records the CS_*_AVG divergence rather than hiding it', () => {
    expect(crossChecks).toHaveLength(60);
    const spreads = crossChecks.map((c) =>
      Math.round(Math.abs(Number(c.published) - Number(c.crossCheck)) * 100),
    );
    expect(Math.min(...spreads)).toBe(1);
    expect(Math.max(...spreads)).toBe(11);
    expect(new Set(crossChecks.map((c) => c.curveDate)).size).toBe(6);
    // Every mismatch names the pair it compared, and none of them is the INDEX/QUOTE date check:
    // `QUOTE_DATE` equals `INDEX_DATE` on all nine entries.
    expect(crossChecks.every((c) => c.check.startsWith('ROUND_B1_'))).toBe(true);
  });

  it('publishes one q: update per resolved tenor line, from the last published day', () => {
    expect(parsed.updates).toHaveLength(7);
    const byLabel = new Map(parsed.updates.map((u) => [u.mdLineId, u]));
    const thirteen = byLabel.get(9204);
    expect(thirteen).toMatchObject({
      subject: 'q:8204',
      instrumentId: 8204,
      assetClass: 'govt',
      tier: 'eod',
      fields: { PX_LAST: 4.07 },
      session: 'closed',
    });
    expect(thirteen?.ts).toEqual({ src: null, cap: raw.capturedAt, pub: 0 });
    expect(thirteen?.prov).toEqual({ sourceId: 'treasury.bills', provenanceId: 1 });
    // No line resolved ⇒ no update, and the rows are unchanged.
    const bare = parseBillRates(raw, { ...ctx, lines: new Map() });
    expect(bare.updates).toEqual([]);
    expect(bare.rows.bills).toHaveLength(63);
  });

  it('never throws on a truncated or corrupted body', () => {
    for (const cut of [0, 1, 500, 5_000, 20_000, raw.body.byteLength - 1]) {
      const broken = { ...raw, body: raw.body.subarray(0, cut) };
      expect(() => parseBillRates(broken, ctx)).not.toThrow();
    }
    const swapped = {
      ...raw,
      body: Buffer.from(
        raw.body
          .toString('utf8')
          .replace(
            '<d:ROUND_B1_CLOSE_4WK_2 m:type="Edm.Double">3.69',
            '<d:ROUND_B1_CLOSE_4WK_2 m:type="Edm.Double">9.69',
          ),
      ),
    };
    const result = parseBillRates(swapped, ctx);
    expect(result.problems.some((p) => p.kind === 'parse_error')).toBe(true);
    const first = result.rows.bills[0];
    expect(first?.discountRate).toBeNull();
    expect(first?.investmentYield).toBeNull();
    // The rest of the day survives: only the transposed pair is dropped.
    expect(result.rows.bills).toHaveLength(63);
  });

  it('registers scheduler-only, under its own licence row', () => {
    const registry = registerTreasuryAdapters(new ProviderRegistry());
    expect(registry.has('treasury.bills')).toBe(true);
    expect(registry.isSchedulerOnly('treasury.bills')).toBe(true);
    expect(treasuryBillsAdapter.sourceId).toBe('treasury.bills');
    expect(treasuryBillsAdapter.adapterVersion).toBe('treasury/1.0.0');
    expect(registry.ids()).toEqual(['treasury.yieldcurve', 'treasury.bills']);
  });
});
