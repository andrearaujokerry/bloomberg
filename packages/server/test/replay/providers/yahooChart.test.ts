/**
 * QA-02 for `yahoo.chart` — WORKPLAN WP-05 L838.
 *
 * Seven committed captures go through `providers/yahoo/parse.ts` and are compared, byte for byte,
 * against the goldens in `fixtures/providers/normalised/`. The bytes are read **through the replay
 * store**, never with `node:fs`: the store recomputes the request key from the URL the adapter
 * builds and verifies the file's sha256, so this suite also proves that `chartUrl()` still
 * addresses the capture it was recorded against — a drifted query parameter fails here rather than
 * silently fetching something else in production.
 *
 * The parse is pure, so the goldens can be compared as text. What the captures actually contain is
 * asserted alongside, because a golden only pins what someone once measured:
 *
 * | capture            | symbol   | granularity | bars | dropped | events        |
 * | ------------------ | -------- | ----------- | ---- | ------- | ------------- |
 * | yahoo-chart-1m     | AAPL     | 1m          | 312  | 1       | —             |
 * | …AAPL-1d-1m.json   | AAPL     | 1m          | 316  | 1       | —             |
 * | …SPX-5d-5m.json    | ^GSPC    | 5m          | 376  | 1       | —             |
 * | yahoo-ftse         | ^FTSE    | 5m          | 103  | 0       | —             |
 * | yahoo-fx           | EURUSD=X | 5m          | 237  | 1       | —             |
 * | yahoo-bond         | ^TNX     | 5m          | 75   | 0       | —             |
 * | yahoo-chart-events | AAPL     | 1d          | 1255 | 0       | 20 dividends  |
 * | …AAPL-max-1d.json  | AAPL     | 3mo (!)     | 169  | 0       | 92 div, 5 spl |
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  chartUrl,
  registerYahooAdapters,
  yahooChartAdapter,
  type YahooChartRequest,
  type YahooChartRows,
} from '../../../src/providers/yahoo/adapter.js';
import { parseYahooChart } from '../../../src/providers/yahoo/parse.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import type { NormaliseContext, NormaliseLine, RawRecord } from '../../../src/providers/types.js';

const store = openReplayStore();

function golden(name: string): string {
  return readFileSync(join(store.dir, 'normalised', name), 'utf8');
}

function capture(req: YahooChartRequest, captureIndex = 0): RawRecord {
  return store.replay({ providerId: 'yahoo.chart', url: chartUrl(req), captureIndex });
}

interface Case {
  golden: string;
  request: YahooChartRequest;
  captureIndex?: number;
  symbol: string;
  granularity: string;
  bars: number;
  droppedBars: number;
  dividends: number;
  splits: number;
  barsWritable: boolean;
}

const CASES: Case[] = [
  {
    golden: 'yahoo-chart-1m.json',
    request: { symbol: 'AAPL', range: '1d', interval: '1m' },
    captureIndex: 0,
    symbol: 'AAPL',
    granularity: '1m',
    bars: 312,
    droppedBars: 1,
    dividends: 0,
    splits: 0,
    barsWritable: true,
  },
  {
    golden: 'yahoo-chart-AAPL-1d-1m.json',
    request: { symbol: 'AAPL', range: '1d', interval: '1m' },
    captureIndex: 1,
    symbol: 'AAPL',
    granularity: '1m',
    bars: 316,
    droppedBars: 1,
    dividends: 0,
    splits: 0,
    barsWritable: true,
  },
  {
    golden: 'yahoo-chart-SPX-5d-5m.json',
    request: { symbol: '^GSPC', range: '5d', interval: '5m' },
    symbol: '^GSPC',
    granularity: '5m',
    bars: 376,
    droppedBars: 1,
    dividends: 0,
    splits: 0,
    barsWritable: true,
  },
  {
    golden: 'yahoo-ftse.json',
    request: { symbol: '^FTSE', range: '1d', interval: '5m' },
    symbol: '^FTSE',
    granularity: '5m',
    bars: 103,
    droppedBars: 0,
    dividends: 0,
    splits: 0,
    barsWritable: true,
  },
  {
    golden: 'yahoo-fx.json',
    request: { symbol: 'EURUSD=X', range: '1d', interval: '5m' },
    symbol: 'EURUSD=X',
    granularity: '5m',
    bars: 237,
    droppedBars: 1,
    dividends: 0,
    splits: 0,
    barsWritable: true,
  },
  {
    golden: 'yahoo-bond.json',
    request: { symbol: '^TNX', range: '1d', interval: '5m' },
    symbol: '^TNX',
    granularity: '5m',
    bars: 75,
    droppedBars: 0,
    dividends: 0,
    splits: 0,
    barsWritable: true,
  },
  {
    golden: 'yahoo-chart-events.json',
    request: { symbol: 'AAPL', range: '5y', interval: '1d', events: true },
    symbol: 'AAPL',
    granularity: '1d',
    bars: 1255,
    droppedBars: 0,
    dividends: 20,
    splits: 0,
    barsWritable: true,
  },
  {
    golden: 'yahoo-chart-AAPL-max-1d.json',
    request: { symbol: 'AAPL', range: 'max', interval: '1d', events: true },
    symbol: 'AAPL',
    granularity: '3mo',
    bars: 169,
    droppedBars: 0,
    dividends: 92,
    splits: 5,
    barsWritable: false,
  },
];

describe('yahoo.chart — URL construction addresses the committed captures', () => {
  it('percent-encodes the symbol the way the manifest holds it', () => {
    expect(chartUrl({ symbol: '^GSPC', range: '5d', interval: '5m' })).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=5m&range=5d',
    );
    expect(chartUrl({ symbol: 'EURUSD=X', range: '1d', interval: '5m' })).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD%3DX?interval=5m&range=1d',
    );
    expect(chartUrl({ symbol: 'AAPL', range: 'max', interval: '1d', events: true })).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=max&events=div%7Csplit',
    );
  });

  it('prefers period1/period2 over range for the daily walk-back', () => {
    expect(chartUrl({ symbol: 'AAPL', range: '5y', interval: '1d', period1: 1, period2: 2 })).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&period1=1&period2=2',
    );
  });
});

describe.each(CASES)('yahoo.chart replay — $golden', (testCase) => {
  const raw = capture(testCase.request, testCase.captureIndex ?? 0);
  const parsed = parseYahooChart({ body: raw.body, url: raw.url });

  it('reads the recorded capture, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.providerId).toBe('yahoo.chart');
    expect(raw.body.length).toBeGreaterThan(0);
  });

  it('equals the committed golden byte for byte', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(golden(testCase.golden));
  });

  it('carries the measured series', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.symbol).toBe(testCase.symbol);
    expect(parsed.granularity).toBe(testCase.granularity);
    expect(parsed.bars).toHaveLength(testCase.bars);
    expect(parsed.dividends).toHaveLength(testCase.dividends);
    expect(parsed.splits).toHaveLength(testCase.splits);
    expect(parsed.barsWritable).toBe(testCase.barsWritable);

    // Every published bar is complete: a null in any of the five is a gap and drops the bar.
    for (const bar of parsed.bars) {
      expect(Number.isFinite(bar.open)).toBe(true);
      expect(Number.isFinite(bar.high)).toBe(true);
      expect(Number.isFinite(bar.low)).toBe(true);
      expect(Number.isFinite(bar.close)).toBe(true);
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
    }
    // Bar starts are strictly increasing, so a chart never doubles back.
    for (let i = 1; i < parsed.bars.length; i++) {
      expect(parsed.bars[i]!.barTs).toBeGreaterThan(parsed.bars[i - 1]!.barTs);
    }

    const dropped = parsed.problems.filter((problem) => problem.kind === 'field_dropped');
    if (testCase.droppedBars === 0) {
      expect(dropped.filter((p) => p.detail.includes('bars dropped'))).toHaveLength(0);
    } else {
      expect(dropped.some((p) => p.detail.startsWith(`${testCase.droppedBars} of `))).toBe(true);
    }
  });
});

describe('yahoo.chart — what each capture measures', () => {
  it('AAPL 1d/1m: 316 minute bars over one regular session, all with volume', () => {
    const raw = capture({ symbol: 'AAPL', range: '1d', interval: '1m' }, 1);
    const parsed = parseYahooChart({ body: raw.body, url: raw.url });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(new Date(parsed.bars[0]!.barTs).toISOString()).toBe('2026-09-15T13:30:00.000Z');
    expect(new Date(parsed.bars.at(-1)!.barTs).toISOString()).toBe('2026-09-15T18:45:43.000Z');
    expect(parsed.bars.every((bar) => bar.session === 'regular')).toBe(true);
    expect(parsed.bars.every((bar) => bar.adjClose === null)).toBe(true);
    // The one dropped bar is 18:45:00Z, the gap minute before the partial bar Yahoo was building.
    expect(parsed.bars.some((bar) => bar.barTs === 1_789_497_900_000)).toBe(false);

    expect(parsed.quote.fields).toEqual({
      PX_LAST: 330.235,
      PX_HIGH: 331.59,
      PX_LOW: 328.35,
      PX_VOLUME: 17_626_556,
      PX_CLOSE_1D: 333.08,
    });
    // `previousClose`, not `chartPreviousClose` — both are 333.08 here, and differ wildly on the
    // `range=max` capture, which is the whole point of the rule.
    expect(parsed.meta.previousClose).toBe(333.08);
    expect(parsed.quote.session).toBe('open');
    expect(parsed.quote.sourceTsMs).toBe(1_789_497_943_000);
  });

  it('^FTSE: the 16:30 London bar is classified post, not regular', () => {
    const raw = capture({ symbol: '^FTSE', range: '1d', interval: '5m' });
    const parsed = parseYahooChart({ body: raw.body, url: raw.url });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const sessions = parsed.bars.reduce<Record<string, number>>((acc, bar) => {
      acc[bar.session] = (acc[bar.session] ?? 0) + 1;
      return acc;
    }, {});
    expect(sessions).toEqual({ regular: 102, post: 1 });
    expect(new Date(parsed.bars.at(-1)!.barTs).toISOString()).toBe('2026-09-15T15:30:00.000Z');
    expect(parsed.quote.session).toBe('post');
  });

  it('an index or fx pair publishing volume 0 gets no PX_VOLUME at all', () => {
    for (const request of [
      { symbol: '^FTSE', range: '1d', interval: '5m' },
      { symbol: '^TNX', range: '1d', interval: '5m' },
      { symbol: 'EURUSD=X', range: '1d', interval: '5m' },
    ] satisfies YahooChartRequest[]) {
      const raw = capture(request);
      const parsed = parseYahooChart({ body: raw.body, url: raw.url });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.meta.regularMarketVolume).toBe(0);
      expect(parsed.quote.fields.PX_VOLUME).toBeUndefined();
      expect(parsed.quote.fields.PX_LAST).toBeGreaterThan(0);
    }

    // ^GSPC does publish an index volume, and it is kept.
    const spx = capture({ symbol: '^GSPC', range: '5d', interval: '5m' });
    const parsedSpx = parseYahooChart({ body: spx.body, url: spx.url });
    expect(parsedSpx.ok).toBe(true);
    if (parsedSpx.ok) expect(parsedSpx.quote.fields.PX_VOLUME).toBe(1_596_229_000);
  });

  it('^GSPC 5d/5m: 376 bars across five sessions, every one inside a published regular window', () => {
    const raw = capture({ symbol: '^GSPC', range: '5d', interval: '5m' });
    const parsed = parseYahooChart({ body: raw.body, url: raw.url });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.meta.regularPeriods).toHaveLength(5);
    expect(parsed.bars.every((bar) => bar.session === 'regular')).toBe(true);
    expect(new Date(parsed.bars[0]!.barTs).toISOString()).toBe('2026-09-09T13:30:00.000Z');
    expect(new Date(parsed.bars.at(-1)!.barTs).toISOString()).toBe('2026-09-15T18:45:48.000Z');
    const days = new Set(parsed.bars.map((bar) => new Date(bar.barTs).toISOString().slice(0, 10)));
    expect(days.size).toBe(5);
  });

  it('5y/1d: 1,255 daily bars, every one with an adjusted close, 20 dividends', () => {
    const raw = capture({ symbol: 'AAPL', range: '5y', interval: '1d', events: true });
    const parsed = parseYahooChart({ body: raw.body, url: raw.url });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.barKind).toBe('daily');
    expect(parsed.barsWritable).toBe(true);
    expect(parsed.bars.filter((bar) => bar.adjClose !== null)).toHaveLength(1255);
    expect(new Date(parsed.bars[0]!.barTs).toISOString()).toBe('2021-09-15T13:30:00.000Z');
    expect(new Date(parsed.bars.at(-1)!.barTs).toISOString()).toBe('2026-09-15T13:30:00.000Z');
    expect(parsed.dividends[0]).toEqual({
      barTsMs: 1_636_119_000_000,
      exTsMs: 1_636_119_000_000,
      exDate: '2021-11-05',
      amount: 0.22,
      currency: 'USD',
    });
    expect(parsed.dividends.at(-1)).toEqual({
      barTsMs: 1_786_368_600_000,
      exTsMs: 1_786_368_600_000,
      exDate: '2026-08-10',
      amount: 0.27,
      currency: 'USD',
    });
    // Dividends come out in time order whatever order the JSON object listed them in.
    for (let i = 1; i < parsed.dividends.length; i++) {
      expect(parsed.dividends[i]!.exTsMs).toBeGreaterThan(parsed.dividends[i - 1]!.exTsMs);
    }
    // No `previousClose` on a long-range payload — the field is absent, never faked from
    // `chartPreviousClose` (149.03 here, the close before the first bar of 2021).
    expect(parsed.meta.previousClose).toBeNull();
    expect(parsed.meta.chartPreviousClose).toBe(149.03);
    expect(parsed.quote.fields.PX_CLOSE_1D).toBeUndefined();
  });

  it('the range=max trap: interval=1d answered with 3mo bars is refused, not stored', () => {
    const raw = capture({ symbol: 'AAPL', range: 'max', interval: '1d', events: true });
    const parsed = parseYahooChart({ body: raw.body, url: raw.url });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.requestedInterval).toBe('1d');
    expect(parsed.granularity).toBe('3mo');
    expect(parsed.granularityMatchesRequest).toBe(false);
    expect(parsed.barKind).toBe('coarse');
    expect(parsed.barsWritable).toBe(false);
    expect(parsed.problems.filter((p) => p.kind === 'schema_drift')).toHaveLength(1);
    // The bars are still parsed (169 quarterly ones) — they are simply not writable.
    expect(parsed.bars).toHaveLength(169);
    expect(parsed.splits).toHaveLength(5);
    expect(parsed.splits.map((split) => split.splitRatio)).toEqual([
      '2:1',
      '2:1',
      '2:1',
      '7:1',
      '4:1',
    ]);
    expect(parsed.splits.every((split) => split.caType === 'split')).toBe(true);
    expect(parsed.dividends).toHaveLength(92);
    // On this payload Yahoo keys the event by the *bar* it falls in, and `date` is the real ex
    // instant; the ex-date always comes from `date` (§5.5).
    expect(parsed.dividends[0]).toEqual({
      barTsMs: 541_573_200_000,
      exTsMs: 547_738_200_000,
      exDate: '1987-05-11',
      amount: 0.000536,
      currency: 'USD',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// normalise — binds a parse to md lines. No database: the context is built here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function line(overrides: Partial<NormaliseLine> = {}): NormaliseLine {
  return {
    mdLineId: 4242,
    instrumentId: 77,
    assetClass: 'equity',
    tier: 'delayed',
    intrinsicDelayMin: 15,
    expectedIntervalMs: 60_000,
    priority: 20,
    ...overrides,
  };
}

function context(lines: Record<string, NormaliseLine>, capturedAt: number): NormaliseContext {
  return { provenanceId: 900_001, capturedAt, lines: new Map(Object.entries(lines)) };
}

describe('yahooChartAdapter.normalise', () => {
  it('writes 316 intraday bars with only the newest one non-final, plus a q: line', () => {
    const raw = capture({ symbol: 'AAPL', range: '1d', interval: '1m' }, 1);
    const result = yahooChartAdapter.normalise(raw, context({ AAPL: line() }, raw.capturedAt));

    expect(result.problems.filter((p) => p.kind === 'unknown_symbol')).toHaveLength(0);
    expect(result.rows.barsIntraday).toHaveLength(316);
    expect(result.rows.barsDaily).toHaveLength(0);
    expect(result.rows.corporateActions).toHaveLength(0);

    const bars = result.rows.barsIntraday;
    expect(bars.filter((bar) => !bar.isFinal)).toHaveLength(1);
    expect(bars.at(-1)!.isFinal).toBe(false);
    expect(bars[0]).toEqual({
      instrumentId: 77,
      barInterval: '1m',
      barTs: '2026-09-15T13:30:00.000Z',
      mdLineId: 4242,
      open: 330.260009765625,
      high: 331.1300048828125,
      low: 328.3500061035156,
      close: 331.0299987792969,
      volume: 1_296_997,
      session: 'regular',
      isFinal: true,
      captureTs: new Date(raw.capturedAt).toISOString(),
    });

    const quote = result.updates.find((update) => update.subject === 'q:77');
    expect(quote?.fields).toEqual({
      PX_LAST: 330.235,
      PX_HIGH: 331.59,
      PX_LOW: 328.35,
      PX_VOLUME: 17_626_556,
      PX_CLOSE_1D: 333.08,
      SESSION_STATE: 'open',
    });
    expect(quote?.ts).toEqual({ src: 1_789_497_943_000, cap: raw.capturedAt, pub: raw.capturedAt });
    expect(quote?.prov).toEqual({ sourceId: 'yahoo.chart', provenanceId: 900_001 });

    const bar = result.updates.find((update) => update.subject === 'b1m:77');
    expect(bar?.ts.src).toBe(1_789_497_943_000);
    expect(bar?.fields.PX_LAST).toBe(bars.at(-1)!.close);
    expect(result.sourceTs?.toISOString()).toBe('2026-09-15T18:45:43.000Z');
  });

  it('writes daily bars with the exchange-local session date and the source adjusted close', () => {
    const raw = capture({ symbol: 'AAPL', range: '5y', interval: '1d', events: true });
    const result = yahooChartAdapter.normalise(raw, context({ AAPL: line() }, raw.capturedAt));

    expect(result.rows.barsIntraday).toHaveLength(0);
    expect(result.rows.barsDaily).toHaveLength(1255);
    expect(result.rows.barsDaily[0]).toEqual({
      instrumentId: 77,
      sessionDate: '2021-09-15',
      mdLineId: 4242,
      open: 148.55999755859375,
      high: 149.44000244140625,
      low: 146.3699951171875,
      close: 149.02999877929688,
      volume: 83_281_300,
      srcAdjClose: expect.any(Number) as number,
      sourceTs: '2021-09-15T13:30:00.000Z',
      captureTs: new Date(raw.capturedAt).toISOString(),
    });
    expect(result.rows.barsDaily.at(-1)!.sessionDate).toBe('2026-09-15');
    expect(new Set(result.rows.barsDaily.map((row) => row.sessionDate)).size).toBe(1255);

    // 20 dividends, all in the past relative to the capture instant, all queued for review.
    expect(result.rows.corporateActions).toHaveLength(20);
    expect(result.rows.corporateActions.every((row) => row.reviewState === 'queued')).toBe(true);
    expect(result.rows.corporateActions.every((row) => row.caType === 'cash_dividend')).toBe(true);
    expect(result.rows.corporateActions.every((row) => row.status === 'paid')).toBe(true);
    expect(result.rows.corporateActions[0]).toMatchObject({
      instrumentId: 77,
      exDate: '2021-11-05',
      amount: 0.22,
      currency: 'USD',
      sourceId: 'yahoo.chart',
    });
  });

  it('refuses to write bars when Yahoo downgraded the granularity, but still queues the actions', () => {
    const raw = capture({ symbol: 'AAPL', range: 'max', interval: '1d', events: true });
    const result = yahooChartAdapter.normalise(raw, context({ AAPL: line() }, raw.capturedAt));

    expect(result.rows.barsIntraday).toHaveLength(0);
    expect(result.rows.barsDaily).toHaveLength(0);
    expect(result.problems.some((p) => p.kind === 'schema_drift')).toBe(true);
    expect(result.rows.corporateActions).toHaveLength(97);
    expect(result.rows.corporateActions.filter((row) => row.caType === 'split')).toHaveLength(5);
    const split = result.rows.corporateActions.find((row) => row.caType === 'split');
    expect(split).toMatchObject({
      ratioNew: 2,
      ratioOld: 1,
      status: 'confirmed',
      reviewState: 'queued',
    });
  });

  it('publishes nothing at all when the symbol has no md line', () => {
    const raw = capture({ symbol: 'AAPL', range: '1d', interval: '1m' }, 1);
    const result = yahooChartAdapter.normalise(raw, context({ MSFT: line() }, raw.capturedAt));

    expect(result.updates).toEqual([]);
    expect(result.rows).toEqual({ barsIntraday: [], barsDaily: [], corporateActions: [] });
    expect(result.problems.filter((p) => p.kind === 'unknown_symbol')).toHaveLength(1);
    // The source timestamp is still reported, so provenance records what the payload published.
    expect(result.sourceTs?.toISOString()).toBe('2026-09-15T18:45:43.000Z');
  });
});

describe('yahoo parse never throws', () => {
  it('returns a parse-error result for truncated, reordered and corrupted input', () => {
    const raw = capture({ symbol: 'AAPL', range: '1d', interval: '1m' }, 1);
    const text = raw.body.toString('utf8');
    const mutations: (Uint8Array | string)[] = [
      '',
      '{',
      text.slice(0, 1024),
      text.slice(0, text.length - 20),
      text.replaceAll('"timestamp"', '"timestamps"'),
      text.replaceAll('330.26', 'null'),
      '{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found"}}}',
      '[]',
      'null',
      new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
    ];
    for (const body of mutations) {
      const result = parseYahooChart({ body, url: raw.url });
      if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
    }

    const notFound = parseYahooChart({
      body: '{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found"}}}',
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) {
      expect(notFound.chartError).toEqual({ code: 'Not Found', description: 'No data found' });
    }

    // A timestamp array longer than the quote arrays rejects the whole payload (§5.5).
    const misaligned = parseYahooChart({
      body: JSON.stringify({
        chart: {
          error: null,
          result: [
            {
              meta: { symbol: 'AAPL', dataGranularity: '1m', gmtoffset: -14400 },
              timestamp: [1, 2, 3],
              indicators: {
                quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 2] }],
              },
            },
          ],
        },
      }),
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1m&range=1d',
    });
    expect(misaligned.ok).toBe(false);
    if (!misaligned.ok) expect(misaligned.problems[0]?.kind).toBe('parse_error');
  });
});

describe('registration', () => {
  it('registers both Yahoo adapters under their licence_registry source ids', () => {
    const registry = registerYahooAdapters(new ProviderRegistry());
    expect(registry.ids()).toEqual(['yahoo.chart', 'yahoo.search']);
    expect(registry.require<YahooChartRequest, YahooChartRows>('yahoo.chart').adapterVersion).toBe(
      'yahoo/1.0.0',
    );
    expect(() => registerYahooAdapters(registry)).toThrow(/already registered/);
  });
});
