/**
 * `treasury-xml2` + `treasury-bills.xml` → `curve_points`, `govt_terms` and the bill master,
 * through `ingest/jobs/treasuryCurves.ts` (WORKPLAN §WP-11, QA-02).
 *
 * The acceptance row asks for two things: *the two captures produce the curve points
 * deterministically, and a re-run writes nothing new*. Everything below is measured from the
 * captures rather than copied from the plan:
 *
 *  - **252 `curve_points`**, not the ≈300 WP-11 estimates: 9 business days × 14 par tenors = 126
 *    on `UST_PAR`, and 9 × 7 bill tenors × 2 quote types = 126 on `UST_BILL`. The estimate is
 *    recorded as a deviation in the report; 252 is what the bytes contain, and the provider-level
 *    suites (`treasuryYieldCurve.test.ts`, `treasuryBills.test.ts`) pin the same 126 + 126.
 *  - **18 bill instruments from 18 distinct CUSIPs**, one issuer, 7 `md_lines` — one per term
 *    label, because the on-the-run bill rolls inside the month and the *label* is the thing that
 *    persists. `4WK` runs `912797VE4 → 912797VK0 → 912797VL8`, so three instruments share one line
 *    over the month and exactly one of them ends it `on_the_run`.
 *  - **every bill curve point carries an `instrument_id`**: the feed publishes a CUSIP for every
 *    tenor on every day, the job mints the instrument before the pass that fills the column, and a
 *    NULL there would mean YAS could not get from the curve to the security.
 *  - **the second run writes nothing** — proved by `count(*)`, by an md5 of every row's content in
 *    a fixed order, and by the `ingest_runs` row count, never by a boolean return value.
 *
 * TESTS ARE SELF-SUFFICIENT (WORKPLAN §0.2). WP-15 owns the seed; this file creates the issuer,
 * the instruments, the `curves` rows and the md lines it needs by *running the job*, inside its
 * own transaction, and names no literal instrument id anywhere.
 *
 * This file lives under `test/replay/`, the single-worker `server-replay` project.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { VirtualClock } from '@terminal/core';

import {
  BILL_RATES_DATASET,
  YIELD_CURVE_DATASET,
  treasuryUrl,
} from '../../../src/providers/treasury/adapter.js';
import {
  TREASURY_ADAPTER_VERSION,
  parseBillRates,
  parseYieldCurve,
} from '../../../src/providers/treasury/parse.js';
import { insertProvenance } from '../../../src/providers/provenance.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import {
  TREASURY_CURVES_SCHEDULE,
  TREASURY_CURVES_TIMEOUT_MS,
  TREASURY_ISSUER_NAME,
  billSecurities,
  currentMonth,
  job,
  mintBillSecurities,
  onTheRunByLabel,
  runTreasuryCurves,
} from '../../../src/ingest/jobs/treasuryCurves.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Tx } from '../../../src/db/client.js';
import type { TreasuryCurvesContext } from '../../../src/ingest/jobs/treasuryCurves.js';
import type { NormaliseContext } from '../../../src/providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The captures, read once
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The frozen clock every WP-10/WP-11 fixture is dated at; its month is the captures' month. */
const AS_OF = Date.parse('2026-09-15T18:41:28Z');
const MONTH = '202609';

const store = openReplayStore();
const parRaw = store.replay({
  providerId: 'treasury.yieldcurve',
  url: treasuryUrl(YIELD_CURVE_DATASET, MONTH),
});
const billRaw = store.replay({
  providerId: 'treasury.bills',
  url: treasuryUrl(BILL_RATES_DATASET, MONTH),
});

const bareCtx = (capturedAt: number): NormaliseContext => ({
  provenanceId: 1,
  capturedAt,
  lines: new Map(),
});

const parParsed = parseYieldCurve(parRaw, bareCtx(parRaw.capturedAt));
const billParsed = parseBillRates(billRaw, bareCtx(billRaw.capturedAt));
const securities = billSecurities(billParsed.rows.bills);

/** Measured: 9 business days × 14 par tenors. */
const PAR_POINTS = 126;
/** Measured: 9 × 7 tenors × (discount rate, investment yield). */
const BILL_POINTS = 126;
const TOTAL_POINTS = PAR_POINTS + BILL_POINTS;
/** Measured: the on-the-run bill rolls inside the month on `4WK` and `13WK`. */
const CUSIPS = 18;
const TERM_LABELS = 7;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The captures and the fold, with no database in the way
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('treasuryCurves — the captures (PROVIDERS §9.1, §9.2)', () => {
  it('reads both recorded captures, never a socket', () => {
    expect(parRaw.origin).toBe('replay');
    expect(billRaw.origin).toBe('replay');
    expect(parRaw.status).toBe(200);
    expect(billRaw.status).toBe(200);
    expect(parParsed.rows.curvePoints).toHaveLength(PAR_POINTS);
    expect(billParsed.rows.curvePoints).toHaveLength(BILL_POINTS);
    expect(billParsed.rows.bills).toHaveLength(63);
  });

  it('asks for the month the clock is in', () => {
    expect(currentMonth({ clock: new VirtualClock(AS_OF) } as TreasuryCurvesContext)).toBe(MONTH);
  });

  it('folds 63 bill rows into 18 CUSIPs and 7 on-the-run labels', () => {
    expect(securities).toHaveLength(CUSIPS);
    // Ascending CUSIP order, so `instrument_id` is a function of the capture, not of a scan.
    expect(securities.map((s) => s.cusip)).toEqual([...securities.map((s) => s.cusip)].sort());
    expect(securities.every((s) => s.maturityDate !== null)).toBe(true);

    const onTheRun = onTheRunByLabel(securities);
    expect([...onTheRun.keys()].sort()).toEqual(
      ['13WK', '17WK', '26WK', '4WK', '52WK', '6WK', '8WK'].sort(),
    );
    // The roll the month contains: `4WK` ends September on its third CUSIP.
    const fourWeek = securities.filter((s) => s.termLabel === '4WK').map((s) => s.cusip);
    expect(fourWeek.length).toBeGreaterThan(1);
    expect(onTheRun.get('4WK')?.cusip).toBe('912797VL8');
  });

  it('declares the §13 scheduler row', () => {
    expect(job.id).toBe('treasuryCurves');
    expect(job.schedule).toBe(TREASURY_CURVES_SCHEDULE);
    expect(TREASURY_CURVES_SCHEDULE).toBe('0 18 * * 1-5');
    expect(job.priority).toBe(2);
    expect(job.timeoutMs).toBe(TREASURY_CURVES_TIMEOUT_MS);
    expect(TREASURY_CURVES_TIMEOUT_MS).toBe(120_000);
    expect(job.provider).toEqual(['treasury.yieldcurve', 'treasury.bills']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The job, against a database it builds for itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t = withTxDb();

function jobContext(tx: Tx): TreasuryCurvesContext {
  return { tx, clock: new VirtualClock(AS_OF), replay: store, months: [MONTH] };
}

interface PointShape {
  rows: number;
  digest: string | null;
}

/**
 * Every `curve_points` row reduced to its content, in a fixed order, as one md5.
 *
 * `provenance_id` is in it deliberately: a second run inserts a *new* `provenance` row, and a
 * writer that re-stamped the existing points with it would be rewriting history. The digest says
 * it did not.
 */
async function pointShape(tx: Tx): Promise<PointShape> {
  const out = await tx.execute<{ n: string; digest: string | null }>(sql`
    SELECT count(*)::text AS n, md5(string_agg(line, E'\n' ORDER BY line)) AS digest
      FROM (
        SELECT concat_ws('|', curve_id, curve_date::text, tenor, quote_type, vintage_at::text,
                         tenor_days::text, value::text, instrument_id::text, maturity_date::text,
                         is_latest::text, provenance_id::text) AS line
          FROM curve_points) s`);
  const row = out.rows[0];
  return { rows: Number(row?.n ?? '0'), digest: row?.digest ?? null };
}

async function countOf(tx: Tx, query: ReturnType<typeof sql>): Promise<number> {
  const out = await tx.execute<{ n: string }>(query);
  return Number(out.rows[0]?.n ?? '0');
}

describe('treasuryCurves — the job, twice over the same captures (QA-02)', () => {
  beforeEach(async () => {
    // Nothing to seed: the job mints the curves, the issuer, the instruments and the md lines.
    // The assertions below start from an empty `curve_points`, which is what `withTxDb` gives.
    expect(await countOf(t.db, sql`SELECT count(*)::text AS n FROM curve_points`)).toBe(0);
  });

  it('writes 252 curve points deterministically, and a second run writes none', async () => {
    const first = await runTreasuryCurves(jobContext(t.db));
    expect(first.errors).toEqual([]);
    expect(first.fetched).toBe(2);
    expect(first.parPoints).toBe(PAR_POINTS);
    expect(first.billPoints).toBe(BILL_POINTS);
    expect(first.inserted).toBe(TOTAL_POINTS);
    expect(first.updated).toBe(0);
    expect(first.skipped).toBe(0);

    const afterFirst = await pointShape(t.db);
    expect(afterFirst.rows).toBe(TOTAL_POINTS);
    expect(afterFirst.digest).not.toBeNull();

    const byCurve = await t.db.execute<{ curve_id: string; n: string; days: string }>(sql`
      SELECT curve_id, count(*)::text AS n, count(DISTINCT curve_date)::text AS days
        FROM curve_points GROUP BY curve_id ORDER BY curve_id`);
    expect(byCurve.rows).toEqual([
      { curve_id: 'UST_BILL', n: String(BILL_POINTS), days: '9' },
      { curve_id: 'UST_PAR', n: String(PAR_POINTS), days: '9' },
    ]);

    const second = await runTreasuryCurves(jobContext(t.db));
    expect(second.errors).toEqual([]);
    expect(second.fetched).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    // Every point was recognised as already held: 252 unchanged, nothing rewritten.
    expect(second.skipped).toBe(TOTAL_POINTS);

    const afterSecond = await pointShape(t.db);
    expect(afterSecond).toEqual(afterFirst);

    // Two executions, two `ingest_runs` rows — one per execution, never one per fetch.
    const runs = await t.db.execute<{ n: string; statuses: string }>(sql`
      SELECT count(*)::text AS n, string_agg(DISTINCT status, ',') AS statuses
        FROM ingest_runs WHERE job_id = 'treasuryCurves'`);
    expect(runs.rows[0]?.n).toBe('2');
    expect(runs.rows[0]?.statuses).toBe('ok');
  });

  it('mints the bill master once: one issuer, 18 instruments, 7 md lines', async () => {
    const first = await runTreasuryCurves(jobContext(t.db));
    expect(first.billSecurities).toBe(CUSIPS);
    expect(first.instrumentsCreated).toBe(CUSIPS);
    expect(first.termsWritten).toBe(CUSIPS);

    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM issuers
             WHERE name = ${TREASURY_ISSUER_NAME} AND tx_to = 'infinity'`,
      ),
    ).toBe(1);
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM instruments
             WHERE asset_class = 'govt' AND tx_to = 'infinity'`,
      ),
    ).toBe(CUSIPS);
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM identifiers
             WHERE scheme = 'CUSIP' AND entity_kind = 'instrument' AND tx_to = 'infinity'`,
      ),
    ).toBe(CUSIPS);
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM md_lines
             WHERE source_id = 'treasury.bills' AND tx_to = 'infinity'`,
      ),
    ).toBe(TERM_LABELS);

    // `govt_terms`: 18 current versions, and exactly one on the run per label.
    const terms = await t.db.execute<{ n: string; on_run: string; labels: string }>(sql`
      SELECT count(*)::text AS n,
             count(*) FILTER (WHERE on_the_run)::text AS on_run,
             count(DISTINCT term_label)::text AS labels
        FROM govt_terms WHERE tx_to = 'infinity'`);
    expect(terms.rows[0]).toEqual({
      n: String(CUSIPS),
      on_run: String(TERM_LABELS),
      labels: String(TERM_LABELS),
    });

    const shape = await t.db.execute<{
      security_type: string;
      coupon_type: string;
      day_count: string;
      calendar_id: string;
      coupon_freq: number;
      coupon_rate: string | null;
    }>(sql`
      SELECT DISTINCT security_type, coupon_type, day_count, calendar_id, coupon_freq, coupon_rate
        FROM govt_terms WHERE tx_to = 'infinity'`);
    expect(shape.rows).toEqual([
      {
        security_type: 'bill',
        coupon_type: 'zero',
        day_count: 'ACT/360',
        calendar_id: 'USGOVT',
        coupon_freq: 0,
        coupon_rate: null,
      },
    ]);

    // A second run recognises everything and writes no version at all.
    const second = await runTreasuryCurves(jobContext(t.db));
    expect(second.instrumentsCreated).toBe(0);
    expect(second.termsWritten).toBe(0);
    expect(
      await countOf(
        t.db,
        sql`SELECT count(*)::text AS n FROM govt_terms WHERE tx_to = 'infinity'`,
      ),
    ).toBe(CUSIPS);
    expect(await countOf(t.db, sql`SELECT count(*)::text AS n FROM govt_terms`)).toBe(CUSIPS);
  });

  it('carries the CUSIP through to every bill curve point, and invents no value', async () => {
    await runTreasuryCurves(jobContext(t.db));

    const bills = await t.db.execute<{ n: string; with_instrument: string; with_maturity: string }>(
      sql`SELECT count(*)::text AS n,
                 count(instrument_id)::text AS with_instrument,
                 count(maturity_date)::text AS with_maturity
            FROM curve_points WHERE curve_id = 'UST_BILL'`,
    );
    expect(bills.rows[0]).toEqual({
      n: String(BILL_POINTS),
      with_instrument: String(BILL_POINTS),
      with_maturity: String(BILL_POINTS),
    });

    // The par curve names no security: a par yield is an interpolated point, not a bond.
    const par = await t.db.execute<{ with_instrument: string }>(sql`
      SELECT count(instrument_id)::text AS with_instrument
        FROM curve_points WHERE curve_id = 'UST_PAR'`);
    expect(par.rows[0]?.with_instrument).toBe('0');

    // Every value is a published Treasury rate: inside the 0–25 % band, and `is_latest` is one
    // per (curve, date, tenor, quote type) — the partial unique index, asserted rather than assumed.
    const band = await t.db.execute<{ lo: string; hi: string; latest: string }>(sql`
      SELECT min(value)::text AS lo, max(value)::text AS hi,
             count(*) FILTER (WHERE is_latest)::text AS latest FROM curve_points`);
    expect(Number(band.rows[0]?.lo)).toBeGreaterThan(0);
    expect(Number(band.rows[0]?.hi)).toBeLessThan(25);
    expect(band.rows[0]?.latest).toBe(String(TOTAL_POINTS));

    // The two `curves` definitions the points hang off were created by the job, not by a seed.
    const curves = await t.db.execute<{ curve_id: string; kind: string; day_count: string }>(sql`
      SELECT curve_id, kind, day_count FROM curves ORDER BY curve_id`);
    expect(curves.rows).toEqual([
      { curve_id: 'UST_BILL', kind: 'bill', day_count: 'ACT/360' },
      { curve_id: 'UST_PAR', kind: 'par', day_count: 'ACT/ACT' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The on-the-run roll ACROSS captures
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The state SRCH's `onTheRun: 'only'` filter and YAS's label read: the CUSIP each term label
 * currently claims, current on both temporal axes.
 */
async function onTheRunRows(tx: Tx): Promise<{ term_label: string; cusip: string }[]> {
  const res = await tx.execute<{ term_label: string; cusip: string }>(sql`
    SELECT term_label, cusip FROM govt_terms
     WHERE on_the_run AND valid_to = 'infinity' AND tx_to = 'infinity'
     ORDER BY term_label, cusip`);
  return res.rows;
}

describe('treasuryCurves — the on-the-run roll across captures (PROVIDERS §9.2)', () => {
  /**
   * The ordinary monthly case, not an edge. The job asks for
   * `field_tdr_date_value_month=YYYYMM`, so on 1 October the September on-the-run bills are not
   * in the file at all — the write loop never visits them and a demotion derived from the capture
   * alone leaves them claiming the label for ever. Two slices of the recorded September file
   * reproduce it exactly: 6 of the 7 labels roll between the first two days and the last day
   * (`52WK` holds `912797WA1` throughout), and the displaced CUSIPs are absent from the later
   * slice.
   */
  it('demotes a bill the later capture no longer names as its label’s on-the-run', async () => {
    const tx = t.db;
    const provenanceId = await insertProvenance(tx, billRaw, {
      adapterVersion: TREASURY_ADAPTER_VERSION,
      sourceTs: billRaw.sourceTs,
    });

    const days = [...new Set(billParsed.rows.bills.map((b) => b.curveDate))].sort();
    const firstTwo = days[1]!;
    const lastDay = days[days.length - 1]!;
    const early = billSecurities(billParsed.rows.bills.filter((b) => b.curveDate <= firstTwo));
    const late = billSecurities(billParsed.rows.bills.filter((b) => b.curveDate >= lastDay));
    expect(early.length).toBeGreaterThan(0);
    expect(late).toHaveLength(TERM_LABELS);

    // Run 1: the first two days of the month.
    const knownAt1 = new Date(billRaw.capturedAt);
    const run1 = await mintBillSecurities(tx, early, { provenanceId, knownAt: knownAt1 });
    expect(run1.instrumentsCreated).toBe(early.length);
    const afterFirst = await onTheRunRows(tx);
    expect(afterFirst).toHaveLength(TERM_LABELS);
    expect(afterFirst.find((r) => r.term_label === '4WK')?.cusip).toBe('912797VE4');

    // Run 2, five days later: the last day alone. Six labels have rolled, and the CUSIPs they
    // rolled off are not in this capture at all — which is exactly why the write loop cannot see
    // them. (`912797WH6` is in the early slice but was never on the run there, so it is not one
    // of them: the demotion is of the CUSIP that *held* the label, not of every CUSIP dropped.)
    const knownAt2 = new Date(billRaw.capturedAt + 5 * 86_400_000);
    const lateCusips = new Set(late.map((s) => s.cusip));
    const displaced = [...onTheRunByLabel(early).values()]
      .map((s) => s.cusip)
      .filter((c) => !lateCusips.has(c));
    expect(displaced).toContain('912797VE4');
    // 6 of the 7 labels roll; `52WK` holds `912797WA1` across both slices.
    expect(displaced).toHaveLength(TERM_LABELS - 1);
    const run2 = await mintBillSecurities(tx, late, { provenanceId, knownAt: knownAt2 });

    // Exactly one on-the-run bill per term label — the invariant SRCH's filter and its summary
    // count depend on, which a capture-local demotion broke for 6 of the 7 labels.
    const afterSecond = await onTheRunRows(tx);
    expect(afterSecond).toHaveLength(TERM_LABELS);
    expect(new Set(afterSecond.map((r) => r.term_label)).size).toBe(TERM_LABELS);
    expect(afterSecond).toEqual(
      [...onTheRunByLabel(late).entries()]
        .map(([term_label, s]) => ({ term_label, cusip: s.cusip }))
        .sort((a, b) => (a.term_label < b.term_label ? -1 : 1)),
    );

    // The displaced bills are still there, still readable, and now say so.
    const demoted = await tx.execute<{ cusip: string; on_the_run: boolean }>(sql`
      SELECT cusip, on_the_run FROM govt_terms
       WHERE cusip = ANY(${sql.param(displaced)}::bpchar[])
         AND valid_to = 'infinity' AND tx_to = 'infinity'
       ORDER BY cusip`);
    expect(demoted.rows).toHaveLength(displaced.length);
    expect(demoted.rows.every((r) => !r.on_the_run)).toBe(true);

    // Every cross-capture demotion is reported as a roll, from the displaced CUSIP to the one
    // that took the label.
    expect(run2.rolls.map((r) => r.from).sort()).toEqual([...displaced].sort());
    // One roll per label, and each names the bill that took the label over.
    expect(new Set(run2.rolls.map((r) => r.termLabel)).size).toBe(displaced.length);
    for (const roll of run2.rolls) {
      expect(roll.to).toBe(onTheRunByLabel(late).get(roll.termLabel)?.cusip);
    }

    // Idempotent: replaying the later slice demotes nothing a second time.
    const run3 = await mintBillSecurities(tx, late, {
      provenanceId,
      knownAt: new Date(billRaw.capturedAt + 6 * 86_400_000),
    });
    expect(run3.rolls).toEqual([]);
    expect(run3.termsWritten).toBe(0);
    expect(await onTheRunRows(tx)).toEqual(afterSecond);
  }, 120_000);
});
