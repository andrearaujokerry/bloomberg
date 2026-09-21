/**
 * `refdata/corporateActions.ts` — WORKPLAN §WP-04 acceptance row 6: an as-of read of
 * `corporate_actions` feeds WP-02's factors (REF-09), and the `review_state` dual key behaves as
 * REF-10 specifies.
 *
 * The fixture is the AAPL 4:1 split of 2020-08-31 as API.md §12.1 L1414-1433 states it — closes
 * 2020-08-27 500.04, 08-28 499.23, 08-31 129.04, 09-01 134.18, the split **recorded** on
 * 2020-07-31 — because that example pins three numbers at once: the factor (0.25), the adjusted
 * close (499.23 × 0.25 = 124.8075) and the REF-03 behaviour of the same request asked as of
 * 2020-07-30, which must return an empty `adjustments` array. Everything is built here, in the
 * test's own rolled-back transaction: WP-15 owns the seed and it does not exist yet.
 *
 * What this file proves:
 *   1. the as-of read hands WP-02 exactly the actions known at `knownAt`, and the factors that
 *      come back are the documented ones;
 *   2. the three-argument form is really three arguments — the dividend factor needs the
 *      unadjusted close of the last session **before** the ex-date, which lies outside the
 *      requested window when the window starts on a non-session day, and the same call with only
 *      the in-window closes throws;
 *   3. REF-10: a `queued` action never moves a price, a reviewer may not be the user who entered
 *      the action, a review is a *correction* on the transaction-time axis (so the pre-review
 *      view of the world is intact), and a reviewed action then does adjust;
 *   4. the natural key `(instrument_id, ca_type, ex_date, source_id)` is reused, so a second
 *      ingest run writes nothing instead of raising `23P01`.
 */

import { applyAdjustment } from '@terminal/core/adjust/corporateActions';
import { adjustmentFactors } from '@terminal/core/adjust/corporateActions';
import { describe, expect, it } from 'vitest';

import {
  actionsAsOf,
  CaReviewError,
  enterAction,
  loadAdjustment,
  loadCloses,
  recordAction,
  reviewAction,
  reviewQueue,
  toCaForAdjust,
} from '../../../src/refdata/corporateActions.js';
import { withTxDb } from '../../../src/test/db.js';

import type { Bar } from '@terminal/core';
import type { CorporateActionRecord } from '../../../src/refdata/corporateActions.js';
import type { TestDb } from '../../../src/test/db.js';

// ── The API.md §12.1 window ──────────────────────────────────────────────────────────────────
/** session → unadjusted close (the published values the API example quotes). */
const CLOSES: readonly (readonly [string, number])[] = [
  ['2020-08-26', 506.09],
  ['2020-08-27', 500.04],
  ['2020-08-28', 499.23],
  ['2020-08-31', 129.04],
  ['2020-09-01', 134.18],
];
const SPLIT_EX = '2020-08-31';
/** The instant the split became known to us — `tx_from`, not the ex-date (WORKPLAN L676-680). */
const SPLIT_KNOWN = new Date('2020-07-31T12:00:00Z');
/** Before that: the world in which the split does not exist yet. */
const BEFORE_SPLIT_KNOWN = new Date('2020-07-30T00:00:00Z');
/** "As we know it now". */
const NOW = new Date('2026-09-15T00:00:00Z');
const ASOF_NOW = { validAt: NOW, knownAt: NOW };

interface Fixture {
  instrumentId: number;
  provenance: (sourceId: string, label: string, capturedAt: Date) => Promise<number>;
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

  const ids = await t.client.query<{ instrument_id: string; md_line_id: string }>(
    `SELECT nextval('instrument_id_seq')::bigint AS instrument_id,
            nextval('md_line_id_seq')::bigint   AS md_line_id`,
  );
  const instrumentId = Number(ids.rows[0]!.instrument_id);
  const mdLineId = Number(ids.rows[0]!.md_line_id);

  const provenance = async (sourceId: string, label: string, capturedAt: Date): Promise<number> => {
    const key = `${label}-${instrumentId}-${String(Math.random()).slice(2)}`;
    const res = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ($1, $2, 'test://ca/' || $2, digest($2, 'sha256'), digest($2, 'sha256'),
               200, 0, $3, 'test/1.0.0')
       RETURNING provenance_id`,
      [sourceId, key, capturedAt.toISOString()],
    );
    return Number(res.rows[0]!.provenance_id);
  };

  // The unadjusted bars. `bars_daily` is always unadjusted (DATA_MODEL §7.2); the adjustment is
  // computed on read, which is the whole of REF-09.
  const barProvenance = await provenance('yahoo.chart', 'bars', new Date('2026-09-15T18:41:28Z'));
  for (const [date, close] of CLOSES) {
    await t.client.query(
      `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                               volume, capture_ts, provenance_id)
       VALUES ($1, $2, $3, $4, $4, $4, $4, 1000000, $5, $6)`,
      [instrumentId, date, mdLineId, close, '2026-09-15T18:41:28Z', barProvenance],
    );
  }
  return { instrumentId, provenance };
}

/** The 4:1 split, recorded on 2020-07-31, `review_state 'auto'` (a machine-clean feed row). */
async function recordSplit(t: TestDb, f: Fixture): Promise<number> {
  const { caId } = await recordAction(t.db, {
    instrumentId: f.instrumentId,
    caType: 'split',
    status: 'paid',
    declaredDate: '2020-07-30',
    exDate: SPLIT_EX,
    ratioNew: 4,
    ratioOld: 1,
    sourceId: 'yahoo.chart',
    reviewState: 'auto',
    provenanceId: await f.provenance('yahoo.chart', 'split', SPLIT_KNOWN),
    txFrom: SPLIT_KNOWN,
  });
  return caId;
}

/** `CLOSES` as `Bar[]`, for `applyAdjustment`. */
function barsOf(dates: readonly string[]): Bar[] {
  return dates.map((date) => {
    const found = CLOSES.find(([d]) => d === date);
    if (found === undefined) throw new Error(`no fixture close for ${date}`);
    return {
      date,
      open: found[1],
      high: found[1],
      low: found[1],
      close: found[1],
      volume: 1000000,
    };
  });
}

describe('the as-of read feeds WP-02 factors (REF-09)', () => {
  const t = withTxDb();

  it('produces the API.md §12.1 split step and adjusted close', async () => {
    const f = await fixture(t);
    await recordSplit(t, f);

    const ctx = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'price',
      asOf: ASOF_NOW,
    });

    expect(ctx.steps).toEqual([
      { beforeDate: '2020-08-31', priceFactor: 0.25, volumeFactor: 4, kind: 'split' },
    ]);
    // The requested window exactly: the lead-in session used for the factors is gone again.
    expect(ctx.closes.map((c) => c.date)).toEqual([
      '2020-08-27',
      '2020-08-28',
      '2020-08-31',
      '2020-09-01',
    ]);
    expect(ctx.leadIn?.date).toBe('2020-08-26');
    // Every close carries the provenance row that supplied the bar (PayloadMeta.provenance[]).
    expect(ctx.provenanceIds.length).toBeGreaterThanOrEqual(2);
    for (const close of ctx.closes) expect(close.provenanceId).toBeGreaterThan(0);

    // And the number the golden states: 499.23 × 0.25.
    const adjusted = applyAdjustment(barsOf(ctx.closes.map((c) => c.date)), ctx.steps);
    expect(adjusted.map((b) => b.close)).toEqual([125.01, 124.8075, 129.04, 134.18]);
    expect(adjusted[0]?.volume).toBe(4000000);
  });

  it('does not see the split as of a knownAt before it was recorded (REF-03)', async () => {
    const f = await fixture(t);
    await recordSplit(t, f);

    const ctx = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'price',
      asOf: { validAt: NOW, knownAt: BEFORE_SPLIT_KNOWN },
    });
    expect(ctx.applied).toEqual([]);
    expect(ctx.steps).toEqual([]);
    // The bars themselves are untouched — the series is simply unadjusted.
    expect(ctx.closes.map((c) => c.close)).toEqual([500.04, 499.23, 129.04, 134.18]);
  });

  it('returns no steps under policy unadjusted, whatever is recorded', async () => {
    const f = await fixture(t);
    await recordSplit(t, f);
    const ctx = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'unadjusted',
      asOf: ASOF_NOW,
    });
    expect(ctx.steps).toEqual([]);
    expect(ctx.applied).toEqual([]);
    expect(ctx.closes).toHaveLength(4);
  });

  it('ignores an action whose ex-date is at or before the window start', async () => {
    const f = await fixture(t);
    await recordSplit(t, f);
    // The window opens on the ex-date itself: the factor applies strictly before it, so it can
    // change no bar in the window and must not be reported as an adjustment.
    const ctx = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: SPLIT_EX,
      end: '2020-09-01',
      policy: 'price',
      asOf: ASOF_NOW,
    });
    expect(ctx.steps).toEqual([]);
    expect(ctx.closes.map((c) => c.date)).toEqual(['2020-08-31', '2020-09-01']);
  });
});

describe('the three-argument form (the close before the ex-date)', () => {
  const t = withTxDb();

  /** A cash dividend on the split date, so its prior close is the session before the window. */
  async function recordDividend(f: Fixture, reviewState: 'auto' | 'queued'): Promise<number> {
    const { caId } = await recordAction(t.db, {
      instrumentId: f.instrumentId,
      caType: 'cash_dividend',
      status: 'paid',
      declaredDate: '2020-07-30',
      exDate: SPLIT_EX,
      amount: 0.82,
      currency: 'USD',
      frequency: 'quarterly',
      sourceId: 'yahoo.chart',
      reviewState,
      provenanceId: await f.provenance('yahoo.chart', `div-${reviewState}`, SPLIT_KNOWN),
      txFrom: SPLIT_KNOWN,
    });
    return caId;
  }

  it('uses the last session before the window when the window starts on a non-session day', async () => {
    const f = await fixture(t);
    await recordSplit(t, f);
    await recordDividend(f, 'auto');

    // 2020-08-29 is a Saturday: the first bar in the window is 08-31, and the close the dividend
    // factor needs — 08-28, 499.23 — is outside it. That is what `[start − 1 session, end]` buys.
    const ctx = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-29',
      end: '2020-09-01',
      policy: 'total_return',
      asOf: ASOF_NOW,
    });
    expect(ctx.closes.map((c) => c.date)).toEqual(['2020-08-31', '2020-09-01']);
    expect(ctx.leadIn).toEqual({
      date: '2020-08-28',
      close: 499.23,
      provenanceId: expect.any(Number),
    });

    const dividend = ctx.steps.find((s) => s.kind === 'dividend');
    expect(dividend?.priceFactor).toBeCloseTo(1 - 0.82 / 499.23, 12);
    expect(dividend?.volumeFactor).toBe(1);
    expect(ctx.steps.find((s) => s.kind === 'split')?.priceFactor).toBe(0.25);

    // …and without that extra session WP-02 refuses to guess: the same actions with only the
    // in-window closes throw, rather than silently dropping the dividend.
    const inWindowOnly = await loadCloses(t.db, f.instrumentId, '2020-08-29', '2020-09-01', false);
    expect(inWindowOnly.map((c) => c.date)).toEqual(['2020-08-31', '2020-09-01']);
    expect(() =>
      adjustmentFactors(ctx.applied.map(toCaForAdjust), inWindowOnly, 'total_return'),
    ).toThrow(/no close before ex-date 2020-08-31/);
  });

  it('leaves the cash factor out under policy price', async () => {
    const f = await fixture(t);
    await recordDividend(f, 'auto');
    const ctx = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-29',
      end: '2020-09-01',
      policy: 'price',
      asOf: ASOF_NOW,
    });
    expect(ctx.steps).toEqual([]);
    expect(ctx.applied).toHaveLength(1);
  });
});

describe('review_state dual key (REF-10)', () => {
  const t = withTxDb();

  /** A dividend entered by hand by user 7: `queued`, with `details.enteredBy = 7`. */
  async function enterDividend(f: Fixture, enteredBy: number): Promise<number> {
    const { caId } = await enterAction(t.db, {
      instrumentId: f.instrumentId,
      caType: 'special_dividend',
      status: 'confirmed',
      declaredDate: '2020-08-20',
      exDate: '2020-09-01',
      amount: 1.5,
      currency: 'USD',
      note: 'phoned in by the desk',
      sourceId: 'internal.user',
      provenanceId: await f.provenance(
        'internal.user',
        'manual-div',
        new Date('2020-08-20T10:00:00Z'),
      ),
      txFrom: new Date('2020-08-20T10:00:00Z'),
      enteredByUserId: enteredBy,
    });
    return caId;
  }

  async function read(caId: number, knownAt: Date): Promise<CorporateActionRecord> {
    const rows = await actionsAsOf(
      t.db,
      {},
      { validAt: new Date('2020-09-02T00:00:00Z'), knownAt },
    );
    const found = rows.find((r) => r.caId === caId);
    if (found === undefined)
      throw new Error(`corporate action ${caId} not visible at ${knownAt.toISOString()}`);
    return found;
  }

  it('queues a hand-entered action and records who entered it', async () => {
    const f = await fixture(t);
    const caId = await enterDividend(f, 7);

    const queued = await read(caId, NOW);
    expect(queued.reviewState).toBe('queued');
    expect(queued.details.enteredBy).toBe(7);
    expect(queued.reviewedBy).toBeNull();
    expect(queued.reviewedAt).toBeNull();

    const queue = await reviewQueue(t.db, { validAt: NOW, knownAt: NOW });
    expect(queue.map((r) => r.caId)).toContain(caId);
  });

  it('refuses a review by the user who entered the action', async () => {
    const f = await fixture(t);
    const caId = await enterDividend(f, 7);

    const refused = await t
      .savepoint(async () =>
        reviewAction(t.db, {
          caId,
          decision: 'reviewed',
          reviewerUserId: 7,
          provenanceId: await f.provenance('internal.user', 'review', NOW),
        }),
      )
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(CaReviewError);
    expect((refused as CaReviewError).code).toBe('ca_dual_key');

    // Nothing was written: the action is still queued and still unreviewed.
    const still = await read(caId, NOW);
    expect(still.reviewState).toBe('queued');
  });

  it('accepts a second pair of eyes, as a correction on the transaction-time axis', async () => {
    const f = await fixture(t);
    const caId = await enterDividend(f, 7);
    const reviewedAt = new Date('2020-08-21T09:00:00Z');

    const reviewed = await reviewAction(t.db, {
      caId,
      decision: 'reviewed',
      reviewerUserId: 9,
      note: 'confirmed against the press release',
      provenanceId: await f.provenance('internal.user', 'review', reviewedAt),
      txFrom: reviewedAt,
      reviewedAt,
    });
    expect(reviewed.reviewState).toBe('reviewed');
    expect(reviewed.reviewedBy).toBe(9);
    expect(reviewed.reviewedAt?.slice(0, 10)).toBe('2020-08-21');
    expect(reviewed.note).toBe('confirmed against the press release');
    // The fact itself is untouched: same valid range, same amount, same ex-date.
    expect(reviewed.amount).toBe(1.5);
    expect(reviewed.exDate).toBe('2020-09-01');
    expect(reviewed.details.enteredBy).toBe(7);

    // The pre-review view of the world is intact — that is what makes the trail worth keeping.
    const before = await read(caId, new Date('2020-08-20T18:00:00Z'));
    expect(before.reviewState).toBe('queued');
    expect(before.reviewedBy).toBeNull();

    // Two versions of one ca_id, abutting on the transaction axis with no gap.
    const versions = await t.client.query<{ review_state: string; tx_from: string; tx_to: string }>(
      `SELECT review_state, tx_from::text, tx_to::text FROM corporate_actions
        WHERE ca_id = $1 ORDER BY tx_from`,
      [caId],
    );
    expect(versions.rows.map((r) => r.review_state)).toEqual(['queued', 'reviewed']);
    expect(versions.rows[0]!.tx_to).toBe(versions.rows[1]!.tx_from);
    expect(versions.rows[1]!.tx_to).toContain('infinity');
  });

  it('never moves a price with a queued action, and does once it is reviewed', async () => {
    const f = await fixture(t);
    const caId = await enterDividend(f, 7);

    const queued = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'total_return',
      asOf: ASOF_NOW,
    });
    expect(queued.steps).toEqual([]);
    expect(queued.applied).toEqual([]);
    expect(queued.skipped.map((r) => [r.caId, r.reviewState])).toEqual([[caId, 'queued']]);

    const reviewedAt = new Date('2020-08-21T09:00:00Z');
    await reviewAction(t.db, {
      caId,
      decision: 'reviewed',
      reviewerUserId: 9,
      provenanceId: await f.provenance('internal.user', 'review', reviewedAt),
      txFrom: reviewedAt,
      reviewedAt,
    });

    const after = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'total_return',
      asOf: ASOF_NOW,
    });
    expect(after.skipped).toEqual([]);
    expect(after.steps).toHaveLength(1);
    // 1 − 1.50 / 129.04 (the close of 2020-08-31, the session before the 09-01 ex-date).
    expect(after.steps[0]?.priceFactor).toBeCloseTo(1 - 1.5 / 129.04, 12);
    expect(after.steps[0]?.kind).toBe('dividend');

    // …but a reader as of before the review still gets nothing: the review is knowledge, and
    // knowledge has a date (REF-03 × REF-10).
    const asOfBeforeReview = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'total_return',
      asOf: { validAt: NOW, knownAt: new Date('2020-08-20T18:00:00Z') },
    });
    expect(asOfBeforeReview.steps).toEqual([]);
    expect(asOfBeforeReview.skipped).toHaveLength(1);
  });

  it('never moves a price with a rejected action', async () => {
    const f = await fixture(t);
    const caId = await enterDividend(f, 7);
    const reviewedAt = new Date('2020-08-21T09:00:00Z');
    const rejected = await reviewAction(t.db, {
      caId,
      decision: 'rejected',
      reviewerUserId: 9,
      note: 'the desk misread the release',
      provenanceId: await f.provenance('internal.user', 'review', reviewedAt),
      txFrom: reviewedAt,
      reviewedAt,
    });
    expect(rejected.reviewState).toBe('rejected');

    const ctx = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'total_return',
      asOf: ASOF_NOW,
    });
    expect(ctx.steps).toEqual([]);
    expect(ctx.skipped.map((r) => r.reviewState)).toEqual(['rejected']);
  });

  it('refuses to review anything that is not queued', async () => {
    const f = await fixture(t);
    const caId = await enterDividend(f, 7);
    const reviewedAt = new Date('2020-08-21T09:00:00Z');
    await reviewAction(t.db, {
      caId,
      decision: 'reviewed',
      reviewerUserId: 9,
      provenanceId: await f.provenance('internal.user', 'review', reviewedAt),
      txFrom: reviewedAt,
      reviewedAt,
    });

    const twice = await t
      .savepoint(async () =>
        reviewAction(t.db, {
          caId,
          decision: 'rejected',
          reviewerUserId: 11,
          provenanceId: await f.provenance('internal.user', 'review2', NOW),
          txFrom: new Date('2020-08-22T09:00:00Z'),
        }),
      )
      .catch((err: unknown) => err);
    expect((twice as CaReviewError).code).toBe('ca_not_queued');

    // An `auto` feed row is not reviewable either: there is nothing to confirm.
    const splitId = await recordSplit(t, f);
    const auto = await t
      .savepoint(async () =>
        reviewAction(t.db, {
          caId: splitId,
          decision: 'reviewed',
          reviewerUserId: 11,
          provenanceId: await f.provenance('internal.user', 'review3', NOW),
        }),
      )
      .catch((err: unknown) => err);
    expect((auto as CaReviewError).code).toBe('ca_not_queued');
  });

  it('reports an unknown ca_id rather than writing one', async () => {
    const f = await fixture(t);
    const missing = await t
      .savepoint(async () =>
        reviewAction(t.db, {
          caId: 999_999_999,
          decision: 'reviewed',
          reviewerUserId: 9,
          provenanceId: await f.provenance('internal.user', 'review4', NOW),
        }),
      )
      .catch((err: unknown) => err);
    expect((missing as CaReviewError).code).toBe('ca_not_found');
  });
});

describe('the natural key (instrument, type, ex-date, source)', () => {
  const t = withTxDb();

  it('reuses the ca_id and writes nothing on a second identical run (QA-02)', async () => {
    const f = await fixture(t);
    const first = await recordSplit(t, f);

    const second = await recordAction(t.db, {
      instrumentId: f.instrumentId,
      caType: 'split',
      status: 'paid',
      declaredDate: '2020-07-30',
      exDate: SPLIT_EX,
      ratioNew: 4,
      ratioOld: 1,
      sourceId: 'yahoo.chart',
      reviewState: 'auto',
      // A fresh fetch: a different provenance row and a later knowledge instant, same facts.
      provenanceId: await f.provenance(
        'yahoo.chart',
        'split-again',
        new Date('2020-08-01T12:00:00Z'),
      ),
      txFrom: new Date('2020-08-01T12:00:00Z'),
    });
    expect(second.caId).toBe(first);
    expect(second.versionId).toBeNull();

    // Counted by rows, not by the return value.
    const rows = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM corporate_actions WHERE ca_id = $1`,
      [first],
    );
    expect(rows.rows[0]!.n).toBe('1');
  });

  it('writes a new version when the feed changes its mind about the status', async () => {
    const f = await fixture(t);
    const caId = await recordSplit(t, f);
    const updated = await recordAction(t.db, {
      instrumentId: f.instrumentId,
      caType: 'split',
      status: 'cancelled',
      declaredDate: '2020-07-30',
      exDate: SPLIT_EX,
      ratioNew: 4,
      ratioOld: 1,
      sourceId: 'yahoo.chart',
      reviewState: 'auto',
      provenanceId: await f.provenance(
        'yahoo.chart',
        'split-cancel',
        new Date('2020-08-02T12:00:00Z'),
      ),
      txFrom: new Date('2020-08-02T12:00:00Z'),
    });
    expect(updated.caId).toBe(caId);
    expect(updated.versionId).not.toBeNull();

    // A cancelled action never adjusts (WP-02 drops it), and the pre-cancellation view still does.
    const now = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'price',
      asOf: ASOF_NOW,
    });
    expect(now.steps).toEqual([]);

    const before = await loadAdjustment(t.db, {
      instrumentId: f.instrumentId,
      start: '2020-08-27',
      end: '2020-09-01',
      policy: 'price',
      asOf: { validAt: NOW, knownAt: new Date('2020-08-01T12:00:00Z') },
    });
    expect(before.steps.map((s) => s.priceFactor)).toEqual([0.25]);
  });

  it('rejects a half-specified ratio before the database has to', async () => {
    const f = await fixture(t);
    await expect(
      recordAction(t.db, {
        instrumentId: f.instrumentId,
        caType: 'split',
        status: 'paid',
        exDate: SPLIT_EX,
        ratioNew: 4,
        sourceId: 'yahoo.chart',
        provenanceId: await f.provenance('yahoo.chart', 'bad-ratio', NOW),
      }),
    ).rejects.toThrow(/both be set or both be null/);
  });
});
