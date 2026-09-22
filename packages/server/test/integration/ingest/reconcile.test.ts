/**
 * `test/integration/ingest/reconcile.test.ts` — WORKPLAN WP-05 acceptance row:
 *
 *   "Cboe vs Yahoo close divergence > 0.5 % writes `cross_source_divergence` (QA-03)."
 *
 * ## Every number here was recorded, not invented
 *
 * A threshold test whose inputs are made up proves only that arithmetic works. These inputs come
 * out of the captures in `fixtures/providers/raw/`, read through `src/test/fixtures.ts`, and the
 * expected divergences are computed from them rather than written down:
 *
 * | Pair | Cboe capture | Yahoo capture | Measured |
 * | --- | --- | --- | --- |
 * | AAPL 2026-09-15 | `cboe-quote-AAPL.json` `data.close` **330.27** | `yahoo-chart-AAPL-max-1d.json`, last daily bar **330.23** | **−0.0121 %** — agrees |
 * | ^SPX 2026-09-15 | `cboe-spx` `data.close` **7585.75** | `yahoo-chart-SPX-5d-5m.json`, last 5-minute close of the session **7582.31** | **−0.0454 %** — agrees |
 * | AAPL, stale Yahoo bar | `cboe-quote-AAPL.json` `data.close` **330.27** | `yahoo-chart-events` close of **2026-09-11**, **332.27** | **+0.6056 %** — diverges |
 * | ^VIX, stale Yahoo bar | `cboe-vix` `data.close` **17.5** | `cboe-vix` `data.prev_day_close` **17.1** as a Yahoo bar that never rolled | **−2.2857 %** — diverges |
 *
 * The two divergent rows are the failure mode this check exists for and the one the captures can
 * actually demonstrate: two healthy sources of the *same* session agree to a basis point, so the
 * only way a real 0.5 % gap appears is when one side is **stale** — a daily bar that never rolled
 * forward. Both divergent cases are built that way, and both use closes that were really
 * published, one session apart, by the source whose bar is stale.
 *
 * ## Self-sufficiency
 *
 * WP-15 owns the seed and it does not exist yet, so this file builds every row it reads —
 * provenance, instrument, both `md_lines`, the bar and the tick — inside the harness's own
 * transaction, which is rolled back afterwards (TESTING §4.3). The only thing it assumes is
 * `licence_registry`, which WP-01's `providers/licences.ts` seeds at migration time and which the
 * `assert_source_known` trigger requires before any row can name a source at all.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { withTxDb } from '../../../src/test/db.js';
import { readRawJson } from '../../../src/test/fixtures.js';
import { testClock } from '../../../src/test/clock.js';
import {
  CBOE_QUOTES_SOURCE_ID,
  CLOSE_CHECK_ID,
  CLOSE_DIVERGENCE_TOLERANCE_PCT,
  YAHOO_CHART_SOURCE_ID,
  closeDivergence,
  loadClosePairs,
  reconcileCloses,
  runReconcile,
  sessionDateOf,
} from '../../../src/ingest/jobs/reconcile.js';
import { masterRepositories } from '../../../src/refdata/master.js';

import type { TestDb } from '../../../src/test/db.js';

// `src/test/fixtures.ts` resolves `REPLAY_DIR` against `packages/server`, and the repository's
// `.env` carries the root-relative `./fixtures/providers`, which lands one directory too deep. The
// captures are a fixed part of the repository, so this file pins the absolute path rather than
// depending on which `.env` the developer has — the same thing `test/setup.int.ts` does for
// `DATABASE_URL`. It must be set on `process.env` (not through `setConfig`) because the integration
// setup clears the memoised config before every test.
process.env.REPLAY_DIR = fileURLToPath(
  new URL('../../../../../fixtures/providers', import.meta.url),
);

// ── The captures ─────────────────────────────────────────────────────────────────────────────

interface CboeQuote {
  timestamp: string;
  data: { symbol: string; close: number; prev_day_close: number; current_price: number };
}

interface YahooChart {
  chart: {
    result: [
      {
        meta: { symbol: string };
        timestamp: number[];
        indicators: { quote: [{ close: (number | null)[] }] };
      },
    ];
  };
}

/** `session_date` → the last non-null close on that UTC date, from a Yahoo chart payload. */
function closesByDate(chart: YahooChart): Map<string, number> {
  const result = chart.chart.result[0];
  const closes = result.indicators.quote[0].close;
  const byDate = new Map<string, number>();
  result.timestamp.forEach((epochSec, i) => {
    const close = closes[i];
    if (close === null || close === undefined) return;
    byDate.set(new Date(epochSec * 1000).toISOString().slice(0, 10), close);
  });
  return byDate;
}

function mustGet(byDate: Map<string, number>, date: string, what: string): number {
  const value = byDate.get(date);
  if (value === undefined) {
    throw new Error(`${what}: the capture has no close for ${date}`);
  }
  return value;
}

/** The session both Cboe captures were taken in (`timestamp` 2026-09-15 18:4x). */
const SESSION = '2026-09-15';
/** The session before it, whose Yahoo close the stale-bar cases reuse. */
const STALE_SESSION = '2026-09-11';

/** 2026-09-15 18:45 ET — the job's own slot, so `sessionDateOf` yields `SESSION`. */
const RUN_AT = Date.parse('2026-09-15T22:45:00.000Z');

interface Measured {
  readonly aaplCboeClose: number;
  readonly aaplYahooClose: number;
  readonly aaplStaleYahooClose: number;
  readonly spxCboeClose: number;
  readonly spxYahooClose: number;
  readonly vixCboeClose: number;
  readonly vixStaleYahooClose: number;
}

let measured: Measured | undefined;

async function measure(): Promise<Measured> {
  if (measured !== undefined) return measured;
  const [aaplCboe, spxCboe, vixCboe, aaplDaily, aaplEvents, spxIntraday] = await Promise.all([
    readRawJson<CboeQuote>('cboe-quote-AAPL.json'),
    readRawJson<CboeQuote>('cboe-spx'),
    readRawJson<CboeQuote>('cboe-vix'),
    readRawJson<YahooChart>('yahoo-chart-AAPL-max-1d.json'),
    readRawJson<YahooChart>('yahoo-chart-events'),
    readRawJson<YahooChart>('yahoo-chart-SPX-5d-5m.json'),
  ]);

  measured = {
    aaplCboeClose: aaplCboe.data.close,
    aaplYahooClose: mustGet(closesByDate(aaplDaily), SESSION, 'yahoo-chart-AAPL-max-1d.json'),
    aaplStaleYahooClose: mustGet(closesByDate(aaplEvents), STALE_SESSION, 'yahoo-chart-events'),
    spxCboeClose: spxCboe.data.close,
    spxYahooClose: mustGet(closesByDate(spxIntraday), SESSION, 'yahoo-chart-SPX-5d-5m.json'),
    vixCboeClose: vixCboe.data.close,
    // The ^VIX capture's own previous-session close: a real published number, one session old,
    // which is exactly what a Yahoo daily bar that failed to roll forward would still be showing.
    vixStaleYahooClose: vixCboe.data.prev_day_close,
  };
  return measured;
}

// ── The fixture ──────────────────────────────────────────────────────────────────────────────

interface Fixture {
  provenance: (sourceId: string) => Promise<number>;
  /**
   * One reconcilable instrument: an instrument, a `cboe.quotes` line, a `yahoo.chart` line and a
   * `bars_daily` row whose `close` is Yahoo's and whose `official_close` is Cboe's.
   */
  instrument: (spec: {
    ticker: string;
    yahooClose: number;
    cboeClose: number | null;
    sessionDate?: string;
    /** Write the Cboe close as a `quote_ticks` row instead of `bars_daily.official_close`. */
    cboeVia?: 'official_close' | 'quote_ticks';
  }) => Promise<number>;
}

const MASTER_KNOWN = new Date('2000-01-01T00:00:00Z');
const LINE_VALID_FROM = new Date('2020-01-01T00:00:00Z');
const CAPTURE_TS = '2026-09-15T20:00:00Z';

function fixture(t: TestDb): Fixture {
  // `md_lines_symbol_excl` allows one writer per (source_id, provider_symbol) over a valid range,
  // so provider symbols are tagged per test run even though the transaction is rolled back.
  const tag = `T${String(Date.now() % 1_000_000)}${String(Math.floor(Math.random() * 1000))}`;
  let seq = 0;

  const provenance = async (sourceId: string): Promise<number> => {
    seq += 1;
    const key = `reconcile-${tag}-${String(seq)}`;
    const res = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ($1, $2, 'test://reconcile/' || $2, digest($2, 'sha256'), digest($2, 'sha256'),
               200, 0, timestamptz '2026-09-15T20:00:00Z', 'test/1.0.0')
       RETURNING provenance_id`,
      [sourceId, key],
    );
    return Number(res.rows[0]!.provenance_id);
  };

  const mdLine = async (spec: {
    instrumentId: number;
    sourceId: string;
    providerSymbol: string;
    expectedIntervalMs: number;
  }): Promise<number> => {
    const res = await t.client.query<{ md_line_id: string }>(
      `INSERT INTO md_lines (instrument_id, source_id, provider_symbol, line_kind,
                             intrinsic_delay_min, expected_interval_ms, valid_from, provenance_id)
       VALUES ($1, $2, $3, 'composite', 15, $4, $5, $6)
       RETURNING md_line_id`,
      [
        spec.instrumentId,
        spec.sourceId,
        spec.providerSymbol,
        spec.expectedIntervalMs,
        LINE_VALID_FROM.toISOString(),
        await provenance(spec.sourceId),
      ],
    );
    return Number(res.rows[0]!.md_line_id);
  };

  const instrument: Fixture['instrument'] = async (spec) => {
    const sessionDate = spec.sessionDate ?? SESSION;
    const issue = await t.client.query<{ issue_id: string }>(
      `SELECT nextval('issue_id_seq')::bigint AS issue_id`,
    );
    const instrumentId = await masterRepositories(t.db).instruments.insert(
      {
        issueId: Number(issue.rows[0]!.issue_id),
        assetClass: 'equity',
        marketSector: 'Equity',
        ticker: `${spec.ticker}.${tag}`,
        exchCode: 'US',
        name: `${spec.ticker} (reconcile fixture)`,
        currency: 'USD',
      },
      {
        validFrom: MASTER_KNOWN,
        provenanceId: await provenance('internal.derived'),
        knownAt: MASTER_KNOWN,
      },
    );

    const yahooLineId = await mdLine({
      instrumentId,
      sourceId: YAHOO_CHART_SOURCE_ID,
      providerSymbol: `${spec.ticker}.${tag}`,
      expectedIntervalMs: 60_000,
    });
    const cboeLineId = await mdLine({
      instrumentId,
      sourceId: CBOE_QUOTES_SOURCE_ID,
      providerSymbol: `${spec.ticker}.${tag}`,
      expectedIntervalMs: 10_000,
    });

    const via = spec.cboeVia ?? 'official_close';
    const officialClose = via === 'official_close' ? spec.cboeClose : null;

    // The bar is Yahoo's: `md_line_id` is the `yahoo.chart` line, `close` is Yahoo's close, and
    // `official_close` is the column Cboe upserts into the same row (PROVIDERS §5.1 L672).
    await t.client.query(
      `INSERT INTO bars_daily (instrument_id, session_date, md_line_id, open, high, low, close,
                               volume, official_close, capture_ts, provenance_id)
       VALUES ($1, $2, $3, $4, $4, $4, $4, 1000000, $5, timestamptz '${CAPTURE_TS}', $6)`,
      [
        instrumentId,
        sessionDate,
        yahooLineId,
        spec.yahooClose,
        officialClose,
        await provenance(YAHOO_CHART_SOURCE_ID),
      ],
    );

    if (via === 'quote_ticks' && spec.cboeClose !== null) {
      await t.client.query(
        `INSERT INTO quote_ticks (capture_ts, instrument_id, md_line_id, kind, price,
                                  source_ts, provenance_id)
         VALUES (timestamptz '${CAPTURE_TS}', $1, $2, 'summary', $3,
                 timestamptz '${CAPTURE_TS}', $4)`,
        [instrumentId, cboeLineId, spec.cboeClose, await provenance(CBOE_QUOTES_SOURCE_ID)],
      );
    }

    return instrumentId;
  };

  return { provenance, instrument };
}

async function divergenceRows(
  t: TestDb,
  instrumentId: number,
): Promise<
  {
    kind: string;
    severity: string;
    source_id: string;
    subject: string;
    details: Record<string, unknown>;
  }[]
> {
  const res = await t.client.query<{
    kind: string;
    severity: string;
    source_id: string;
    subject: string;
    details: Record<string, unknown>;
  }>(
    `SELECT kind, severity, source_id, subject, details
       FROM dq_events
      WHERE instrument_id = $1 AND kind = 'cross_source_divergence'
      ORDER BY dq_id`,
    [instrumentId],
  );
  return res.rows;
}

// ── The pure threshold ───────────────────────────────────────────────────────────────────────

describe('closeDivergence — the 0.5 % threshold (PROVIDERS §14.2)', () => {
  it('measures the recorded AAPL and ^SPX pairs as agreeing', async () => {
    const m = await measure();

    expect(m.aaplCboeClose).toBe(330.27);
    expect(m.aaplYahooClose).toBeCloseTo(330.23, 4);
    const aapl = closeDivergence(m.aaplCboeClose, m.aaplYahooClose);
    expect(aapl.incomparable).toBe(false);
    expect(aapl.diffPct).toBeCloseTo(-0.012108, 5);
    expect(aapl.exceeds).toBe(false);

    expect(m.spxCboeClose).toBe(7585.75);
    expect(m.spxYahooClose).toBeCloseTo(7582.31, 3);
    const spx = closeDivergence(m.spxCboeClose, m.spxYahooClose);
    expect(spx.diffPct).toBeCloseTo(-0.045347, 5);
    expect(spx.exceeds).toBe(false);
  });

  it('measures both stale-bar pairs as exceeding the tolerance', async () => {
    const m = await measure();

    expect(m.aaplStaleYahooClose).toBeCloseTo(332.27, 4);
    const aapl = closeDivergence(m.aaplCboeClose, m.aaplStaleYahooClose);
    expect(aapl.diffPct).toBeCloseTo(0.605562, 5);
    expect(aapl.exceeds).toBe(true);

    expect(m.vixCboeClose).toBe(17.5);
    expect(m.vixStaleYahooClose).toBe(17.1);
    const vix = closeDivergence(m.vixCboeClose, m.vixStaleYahooClose);
    expect(vix.diffPct).toBeCloseTo(-2.285714, 5);
    expect(vix.exceeds).toBe(true);
  });

  it('is exclusive at the boundary: exactly 0.5 % does not fire, a hair over does', async () => {
    const m = await measure();
    const cboe = m.aaplCboeClose;

    const exactlyOn = closeDivergence(cboe, cboe * (1 + CLOSE_DIVERGENCE_TOLERANCE_PCT / 100));
    expect(exactlyOn.diffPct).toBeCloseTo(0.5, 10);
    expect(exactlyOn.exceeds).toBe(false);

    const justOver = closeDivergence(cboe, cboe * 1.005001);
    expect(justOver.exceeds).toBe(true);

    const justUnder = closeDivergence(cboe, cboe * 1.004999);
    expect(justUnder.exceeds).toBe(false);

    // Symmetric: the tolerance is on |diff|, so a Yahoo close below Cboe fires on the same gap.
    const below = closeDivergence(cboe, cboe * 0.994999);
    expect(below.diffPct).toBeLessThan(0);
    expect(below.exceeds).toBe(true);
  });

  it('refuses to compare against a zero reference', () => {
    const verdict = closeDivergence(0, 12.5);
    expect(verdict.incomparable).toBe(true);
    expect(verdict.exceeds).toBe(false);
  });
});

// ── The job ──────────────────────────────────────────────────────────────────────────────────

describe('reconcile — Cboe vs Yahoo closes write cross_source_divergence (QA-03)', () => {
  const t = withTxDb();
  const clock = testClock(RUN_AT);

  it('reconciles the job slot to the session that just closed', () => {
    expect(sessionDateOf(RUN_AT)).toBe(SESSION);
  });

  it('leaves the two agreeing pairs alone', async () => {
    const m = await measure();
    const f = fixture(t);
    const aapl = await f.instrument({
      ticker: 'AAPL',
      yahooClose: m.aaplYahooClose,
      cboeClose: m.aaplCboeClose,
    });
    const spx = await f.instrument({
      ticker: 'SPX',
      yahooClose: m.spxYahooClose,
      cboeClose: m.spxCboeClose,
    });

    const outcome = await reconcileCloses({ clock, tx: t.db }, { sessionDate: SESSION });

    expect(outcome.examined).toBe(2);
    expect(outcome.compared).toBe(2);
    expect(outcome.diverged).toBe(0);
    expect(outcome.raised).toBe(0);
    expect(await divergenceRows(t, aapl)).toEqual([]);
    expect(await divergenceRows(t, spx)).toEqual([]);
  });

  it('writes one cross_source_divergence row for a stale Yahoo bar and none for the healthy pair', async () => {
    const m = await measure();
    const f = fixture(t);
    const healthy = await f.instrument({
      ticker: 'AAPL',
      yahooClose: m.aaplYahooClose,
      cboeClose: m.aaplCboeClose,
    });
    // The same Cboe close, against the Yahoo close of 2026-09-11 — a daily bar that never rolled.
    const stale = await f.instrument({
      ticker: 'AAPLSTALE',
      yahooClose: m.aaplStaleYahooClose,
      cboeClose: m.aaplCboeClose,
    });

    const outcome = await reconcileCloses({ clock, tx: t.db }, { sessionDate: SESSION });

    expect(outcome.compared).toBe(2);
    expect(outcome.diverged).toBe(1);
    expect(outcome.raised).toBe(1);

    const finding = outcome.findings[0]!;
    expect(finding.instrumentId).toBe(stale);
    expect(finding.check).toBe(CLOSE_CHECK_ID);
    expect(finding.sessionDate).toBe(SESSION);
    expect(finding.expected).toBeCloseTo(m.aaplCboeClose, 6);
    expect(finding.actual).toBeCloseTo(m.aaplStaleYahooClose, 4);
    expect(finding.diffPct).toBeCloseTo(0.605562, 5);
    expect(finding.tolerancePct).toBe(CLOSE_DIVERGENCE_TOLERANCE_PCT);
    expect(finding.expectedFrom).toBe('bars_daily.official_close');
    expect(finding.actualFrom).toBe('bars_daily.close');
    expect(finding.dqId).not.toBeNull();

    expect(await divergenceRows(t, healthy)).toEqual([]);

    const rows = await divergenceRows(t, stale);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe('cross_source_divergence');
    expect(row.severity).toBe('warn');
    expect(row.source_id).toBe(CBOE_QUOTES_SOURCE_ID);
    expect(row.subject).toBe(`q:${String(stale)}`);
    expect(row.details.expected).toBeCloseTo(m.aaplCboeClose, 6);
    expect(row.details.actual).toBeCloseTo(m.aaplStaleYahooClose, 4);
    expect(row.details.diffPct).toBeCloseTo(0.605562, 5);
    expect(row.details.tolerancePct).toBe(CLOSE_DIVERGENCE_TOLERANCE_PCT);
    expect(row.details.actualSourceId).toBe(YAHOO_CHART_SOURCE_ID);
    expect(row.details.sessionDate).toBe(SESSION);
  });

  it('takes the Cboe side from quote_ticks when no official close was written', async () => {
    const m = await measure();
    const f = fixture(t);
    const vix = await f.instrument({
      ticker: 'VIX',
      yahooClose: m.vixStaleYahooClose,
      cboeClose: m.vixCboeClose,
      cboeVia: 'quote_ticks',
    });

    const pairs = await loadClosePairs({ clock, tx: t.db }, SESSION);
    const pair = pairs.find((p) => p.instrumentId === vix)!;
    expect(pair.cboeClose).toBeCloseTo(m.vixCboeClose, 6);
    expect(pair.cboeFrom?.startsWith('quote_ticks.price@')).toBe(true);
    expect(pair.yahooClose).toBeCloseTo(m.vixStaleYahooClose, 6);

    const outcome = await reconcileCloses({ clock, tx: t.db }, { sessionDate: SESSION });
    expect(outcome.diverged).toBe(1);
    expect(outcome.findings[0]!.diffPct).toBeCloseTo(-2.285714, 5);
    expect(outcome.findings[0]!.expectedFrom.startsWith('quote_ticks.price@')).toBe(true);

    const rows = await divergenceRows(t, vix);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.diffPct).toBeCloseTo(-2.285714, 5);
  });

  it('cannot compare an instrument with only one side, and says so rather than guessing', async () => {
    const m = await measure();
    const f = fixture(t);
    const orphan = await f.instrument({
      ticker: 'NOCBOE',
      yahooClose: m.aaplYahooClose,
      cboeClose: null,
    });

    const pairs = await loadClosePairs({ clock, tx: t.db }, SESSION);
    const pair = pairs.find((p) => p.instrumentId === orphan)!;
    expect(pair.cboeClose).toBeNull();
    expect(pair.yahooClose).toBeCloseTo(m.aaplYahooClose, 4);

    const outcome = await reconcileCloses({ clock, tx: t.db }, { sessionDate: SESSION });
    expect(outcome.examined).toBe(1);
    expect(outcome.compared).toBe(0);
    expect(outcome.diverged).toBe(0);
    expect(await divergenceRows(t, orphan)).toEqual([]);
  });

  it('is idempotent: a second run opens no second row for the same session', async () => {
    const m = await measure();
    const f = fixture(t);
    const stale = await f.instrument({
      ticker: 'AAPLSTALE',
      yahooClose: m.aaplStaleYahooClose,
      cboeClose: m.aaplCboeClose,
    });

    const first = await reconcileCloses({ clock, tx: t.db }, { sessionDate: SESSION });
    expect(first.raised).toBe(1);

    const second = await reconcileCloses({ clock, tx: t.db }, { sessionDate: SESSION });
    expect(second.diverged).toBe(1);
    expect(second.raised).toBe(0);
    expect(second.findings[0]!.dqId).toBeNull();

    expect(await divergenceRows(t, stale)).toHaveLength(1);
  });

  it('a dry run measures the divergence and writes nothing', async () => {
    const m = await measure();
    const f = fixture(t);
    const stale = await f.instrument({
      ticker: 'AAPLSTALE',
      yahooClose: m.aaplStaleYahooClose,
      cboeClose: m.aaplCboeClose,
    });

    const outcome = await reconcileCloses(
      { clock, tx: t.db },
      { sessionDate: SESSION, dryRun: true },
    );
    expect(outcome.diverged).toBe(1);
    expect(outcome.raised).toBe(0);
    expect(outcome.findings[0]!.dqId).toBeNull();
    expect(await divergenceRows(t, stale)).toEqual([]);
  });

  it('restricts itself to the hot set when one is supplied (§14.2 "per hot instrument")', async () => {
    const m = await measure();
    const f = fixture(t);
    const hot = await f.instrument({
      ticker: 'AAPLSTALE',
      yahooClose: m.aaplStaleYahooClose,
      cboeClose: m.aaplCboeClose,
    });
    const cold = await f.instrument({
      ticker: 'VIXSTALE',
      yahooClose: m.vixStaleYahooClose,
      cboeClose: m.vixCboeClose,
    });

    const outcome = await reconcileCloses(
      { clock, tx: t.db },
      { sessionDate: SESSION, instrumentIds: [hot] },
    );

    expect(outcome.examined).toBe(1);
    expect(outcome.diverged).toBe(1);
    expect(outcome.findings[0]!.instrumentId).toBe(hot);
    expect(await divergenceRows(t, cold)).toEqual([]);
  });

  it('only reconciles the requested session', async () => {
    const m = await measure();
    const f = fixture(t);
    const other = await f.instrument({
      ticker: 'AAPLSTALE',
      yahooClose: m.aaplStaleYahooClose,
      cboeClose: m.aaplCboeClose,
      sessionDate: '2026-09-14',
    });

    const outcome = await reconcileCloses({ clock, tx: t.db }, { sessionDate: SESSION });
    expect(outcome.examined).toBe(0);
    expect(await divergenceRows(t, other)).toEqual([]);
  });

  it('runReconcile reports the check, the counters and the finding', async () => {
    const m = await measure();
    const f = fixture(t);
    const healthy = await f.instrument({
      ticker: 'AAPL',
      yahooClose: m.aaplYahooClose,
      cboeClose: m.aaplCboeClose,
    });
    const stale = await f.instrument({
      ticker: 'VIXSTALE',
      yahooClose: m.vixStaleYahooClose,
      cboeClose: m.vixCboeClose,
    });

    const result = await runReconcile({ clock, tx: t.db });

    expect(result.sessionDate).toBe(SESSION);
    expect(result.errors).toEqual([]);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.id).toBe(CLOSE_CHECK_ID);
    expect(result.fetched).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.instrumentId).toBe(stale);
    expect(await divergenceRows(t, healthy)).toEqual([]);
    expect(await divergenceRows(t, stale)).toHaveLength(1);
  });
});
