// packages/web/test/chart/streaming.test.ts — WP-14 acceptance row: "the forming bar updates in
// place; a finalised bar (`IS_FINAL`) is not redrawn again" (CLIENT.md §11.5, CHRT-02, TERM-12).
//
// ## Why this file builds its `QuoteView`s through the real cache
//
// `src/chart/streaming.ts` reads a `QuoteView`. A hand-built object literal shaped like one would
// prove nothing about the product — that is the third of this build's four unfalsifiable tests, and
// the b1m: field mapping is exactly the kind of thing it would fail to catch, because a literal is
// written to match the code under test rather than to match the wire. So every view here comes from
// a `snap`/`delta` frame that is first `Snap.parse`d / `Delta.parse`d by the real wire schema and
// then applied by the real WP-13 `QuoteCache`. If the plant could not send the frame, this file
// cannot test with it.
//
// ## Why the bars are real
//
// `fixtures/providers/normalised/yahoo-chart-AAPL-1d-1m.json` — 316 one-minute bars of a real
// session, on disk, no network (FEED-08, QA-02). A streaming test on a synthetic ramp would not show
// the one thing the fixture does: the last capture of a poll is a partial minute (`barTs`
// 1789497943000, forty-three seconds into it), which is precisely the bar the plant carries on
// `b1m:` and the bar §11.5 overwrites in place.
//
// ## Why the renderer is here
//
// §11.5's three rules — the same-timestamp overwrite, the `IS_FINAL` seal, the refusal of a bar
// behind the last slot — used to be implemented TWICE: once in `streaming.ts` (`LiveSeriesBuffer`,
// `ChartStream.apply`) and once in `Renderer.applyStream`, over the arrays that are actually drawn.
// Nothing in the product ever called the first, so the twenty-five tests in this file proved a
// contract no chart used, while the implementation that draws was covered incidentally elsewhere. Two
// implementations of one contract drift, so there is now one owner — the renderer, which owns the
// dirty region — and this file drives the pair the component drives: `ChartStream.updatesFrom` to
// decode the frame, `Renderer.applyStream` to apply it.
//
// That means a canvas (node-canvas, as `renderer.test.ts` uses) but still no frame pump: what is
// asserted below is the CONTENT of the columns after a patch, never a pixel, so nothing has to be
// drawn and nothing has to be flushed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QuoteCache, Snap as SnapSchema, Delta as DeltaSchema } from '@terminal/sdk';
import type { Delta, FieldValue, QuoteView, Snap, UpdateEvent } from '@terminal/sdk';
import { describe, expect, it } from 'vitest';

import { Renderer } from '../../src/chart/renderer.js';
import {
  ChartStream,
  FORMING_BAR_FIELDS,
  followOnAppend,
  formingBarFrom,
  liveBindings,
} from '../../src/chart/streaming.js';
import type { LiveUpdate } from '../../src/chart/streaming.js';
import type { StudyDef, StudyInput } from '../../src/chart/studies/types.js';
import type {
  ChartFonts,
  ChartSeries,
  ChartSpec,
  ChartTheme,
  Viewport,
} from '../../src/chart/types.js';
import { COLOUR_TOKENS } from '../../src/theme/colours.js';
import type { ColourToken } from '../../src/theme/colours.js';

/** `packages/web/test/chart/` → `packages/web/` → the monorepo root (see `no-direct-io.test.ts`). */
const WEB_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(WEB_ROOT));

interface NormalisedBar {
  barTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

const INTRADAY: { bars: NormalisedBar[]; granularity: string } = JSON.parse(
  readFileSync(
    join(REPO_ROOT, 'fixtures', 'providers', 'normalised', 'yahoo-chart-AAPL-1d-1m.json'),
    'utf8',
  ),
) as { bars: NormalisedBar[]; granularity: string };

const BARS = INTRADAY.bars;
const INSTRUMENT_ID = 42;
const BAR_SUBJECT = `b1m:${String(INSTRUMENT_ID)}`;
const QUOTE_SUBJECT = `q:${String(INSTRUMENT_ID)}`;
const MINUTE_MS = 60_000;

/**
 * The spec `GIP/Screen.tsx#gipChartSpec` builds, over the fixture's bars.
 *
 * Copied in shape, not imported: `gipChartSpec` takes a `GipPayload`, and assembling one would put a
 * hundred lines of unrelated payload between this file and the thing it tests. What matters is that
 * the series is the one that screen produces — a `candle` with `ohlc`, `volume`, and
 * `live: { subject: 'b1m:<id>', field: 'PX_LAST', mode: 'append-forming-bar' }` — and that is
 * reproduced field for field.
 */
function makeSpec(
  options: { quoteLine?: boolean; barLine?: boolean; candleOnQuote?: boolean } = {},
): ChartSpec {
  const t = Float64Array.from(BARS, (b) => b.barTs);
  const series: ChartSeries[] = [
    {
      id: 'p',
      label: 'AAPL US Equity',
      type: 'candle',
      pane: 'main',
      yAxis: 'y',
      x: t,
      y: Float64Array.from(BARS, (b) => b.close),
      ohlc: {
        o: Float64Array.from(BARS, (b) => b.open),
        h: Float64Array.from(BARS, (b) => b.high),
        l: Float64Array.from(BARS, (b) => b.low),
        c: Float64Array.from(BARS, (b) => b.close),
      },
      volume: Float64Array.from(BARS, (b) => b.volume ?? 0),
      provIdx: 0,
      currency: 'USD',
      calendarId: 'XNAS',
      live:
        options.candleOnQuote === true
          ? { subject: QUOTE_SUBJECT, field: 'PX_LAST', mode: 'replace-last' }
          : { subject: BAR_SUBJECT, field: 'PX_LAST', mode: 'append-forming-bar' },
    },
  ];
  if (options.quoteLine === true) {
    series.push({
      id: 'last',
      label: 'Last',
      type: 'line',
      pane: 'main',
      yAxis: 'y',
      x: Float64Array.from(t),
      y: Float64Array.from(BARS, (b) => b.close),
      provIdx: 0,
      live: { subject: QUOTE_SUBJECT, field: 'PX_LAST', mode: 'replace-last' },
    });
  }
  if (options.barLine === true) {
    // A second series on the SAME b1m: subject — GP overlays the close line of the instrument it is
    // already drawing as candles. The fan-out is what this exercises.
    series.push({
      id: 'close',
      label: 'Close',
      type: 'line',
      pane: 'main',
      yAxis: 'y',
      x: Float64Array.from(t),
      y: Float64Array.from(BARS, (b) => b.close),
      provIdx: 0,
      live: { subject: BAR_SUBJECT, field: 'PX_LAST', mode: 'append-forming-bar' },
    });
  }
  return {
    kind: 'intraday',
    xAxis: { type: 'time', tz: 'America/New_York', calendarId: 'XNAS' },
    yAxes: [{ id: 'y', side: 'right', scale: 'linear', fmt: 'px', decimals: 2 }],
    panes: [{ id: 'main', height: 1 }],
    series,
    crosshair: true,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Real frames through the real cache                                                             */
/* -------------------------------------------------------------------------------------------- */

const CAPTURED_AT = 1_789_497_950_000;

/** A `snap` for a subject, validated by `wire/ws.ts#Snap` before it reaches the cache. */
function snapFrame(subject: string, f: Record<string, FieldValue>, srcTs: number | null): Snap {
  return SnapSchema.parse({
    t: 'snap',
    s: subject,
    seq: 1,
    tier: 'delayed',
    reason: 'OK',
    f,
    ts: { src: srcTs, cap: CAPTURED_AT, pub: CAPTURED_AT },
    st: 'live',
    session: 'open',
    prov: { p: 'yahoo.chart', id: 9001 },
    ac: 'equity',
    id: INSTRUMENT_ID,
  });
}

/** A `delta` continuing the chain — `prev` must equal the view's `seq` or the cache refuses it. */
function deltaFrame(
  subject: string,
  seq: number,
  f: Record<string, FieldValue>,
  srcTs: number | null,
): Delta {
  return DeltaSchema.parse({
    t: 'delta',
    s: subject,
    seq,
    prev: seq - 1,
    f,
    ts: { src: srcTs, cap: CAPTURED_AT, pub: CAPTURED_AT },
    st: 'live',
  });
}

/** The fields the plant publishes for a forming bar, from a fixture bar. */
function barFields(bar: NormalisedBar, final: boolean): Record<string, FieldValue> {
  return {
    BAR_TS: bar.barTs,
    PX_OPEN: bar.open,
    PX_HIGH: bar.high,
    PX_LOW: bar.low,
    PX_LAST: bar.close,
    PX_VOLUME: bar.volume,
    IS_FINAL: final,
  };
}

/** A cache holding one subject, and the `UpdateEvent` builder for it. */
function liveSubject(subject: string, f: Record<string, FieldValue>, srcTs: number | null) {
  const cache = new QuoteCache();
  const first = cache.apply(snapFrame(subject, f, srcTs));
  let seq = 1;
  const view = (): QuoteView => {
    const held = cache.get(subject);
    if (held === undefined) throw new Error(`cache lost ${subject}`);
    return held;
  };
  return {
    cache,
    view,
    /** The `snap`'s own update event. */
    snapEvent: (): UpdateEvent => ({
      subject,
      seq: 1,
      changed: first.changed,
      state: view(),
      kind: 'snap',
    }),
    /** Push a delta and return the `UpdateEvent` the bridge would fan out. */
    push: (fields: Record<string, FieldValue>, srcTsNext: number | null): UpdateEvent => {
      seq += 1;
      const result = cache.apply(deltaFrame(subject, seq, fields, srcTsNext));
      expect(result.resyncNeeded, 'the delta chain broke — the test built a bad frame').toBe(false);
      return { subject, seq, changed: result.changed, state: view(), kind: 'delta' };
    },
  };
}

const lastBar = (): NormalisedBar => {
  const bar = BARS[BARS.length - 1];
  if (bar === undefined) throw new Error('the intraday fixture has no bars');
  return bar;
};

/* -------------------------------------------------------------------------------------------- */

describe('the fixture this file streams (FEED-08, QA-02)', () => {
  it('is the 316-bar one-minute capture, whose last bar is a partial minute', () => {
    expect(INTRADAY.granularity).toBe('1m');
    expect(BARS).toHaveLength(316);
    // The premise of the whole overwrite path: the plant's newest bar is not on a minute boundary.
    expect(lastBar().barTs % MINUTE_MS).not.toBe(0);
  });
});

describe('the b1m: contract (streaming.ts header, API.md §6.1, WORKPLAN open question 10)', () => {
  it('names exactly the fields API.md §6.1 lists for b1m:', () => {
    // A transcription check against the source, like `types.test.ts` runs for the name tables: the
    // field list is the contract, and a field dropped here is a bar column that silently stops
    // updating.
    const api = readFileSync(join(REPO_ROOT, 'docs', 'API.md'), 'utf8');
    const row = api.split('\n').find((line) => line.startsWith('| `b1m:<instrumentId>`'));
    expect(row, 'API.md §6.1 no longer has a b1m: row').toBeDefined();
    const documented = /\| `([A-Z_ ]+)` \|/.exec(row ?? '')?.[1]?.trim().split(/\s+/) ?? [];
    expect(documented).toHaveLength(7);
    expect([...FORMING_BAR_FIELDS]).toEqual(documented);
  });

  it('maps BAR_TS/PX_OPEN/PX_HIGH/PX_LOW/PX_LAST/PX_VOLUME/IS_FINAL onto the bar', () => {
    const bar = lastBar();
    const { view } = liveSubject(BAR_SUBJECT, barFields(bar, false), bar.barTs);
    expect(formingBarFrom(view())).toEqual({
      t: bar.barTs,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume ?? 0,
      final: false,
    });
  });

  it('falls back to ts.src for t, which is where the yahoo adapter publishes the bar instant', () => {
    // `providers/yahoo/adapter.ts` omits BAR_TS from `fields` and sets `ts.src = newest.barTs`.
    // Without this fallback every GIP chart in the build would refuse every forming bar.
    const bar = lastBar();
    const fields = barFields(bar, false);
    delete fields.BAR_TS;
    const { view } = liveSubject(BAR_SUBJECT, fields, bar.barTs);
    expect(formingBarFrom(view())?.t).toBe(bar.barTs);
  });

  it('reads IS_FINAL strictly: absent or false is forming, only true seals', () => {
    const bar = lastBar();
    const absent = barFields(bar, false);
    delete absent.IS_FINAL;
    const { view: withoutField } = liveSubject(BAR_SUBJECT, absent, bar.barTs);
    expect(formingBarFrom(withoutField())?.final).toBe(false);

    const { view: sealed } = liveSubject(BAR_SUBJECT, barFields(bar, true), bar.barTs);
    expect(formingBarFrom(sealed())?.final).toBe(true);
  });

  it('carries the close into o/h/l when only PX_LAST is reported, and 0 volume when none is', () => {
    const bar = lastBar();
    const { view } = liveSubject(BAR_SUBJECT, { PX_LAST: bar.close }, bar.barTs);
    expect(formingBarFrom(view())).toEqual({
      t: bar.barTs,
      o: bar.close,
      h: bar.close,
      l: bar.close,
      c: bar.close,
      v: 0,
      final: false,
    });
  });

  it('refuses a bar with no close — which is what an entitlement denial looks like (ENTL-05)', () => {
    const bar = lastBar();
    const denied = liveSubject(
      BAR_SUBJECT,
      { ...barFields(bar, false), PX_LAST: null },
      bar.barTs,
    );
    expect(formingBarFrom(denied.view())).toBeNull();
  });

  it('refuses a bar with no instant at all', () => {
    const bar = lastBar();
    const fields = barFields(bar, false);
    delete fields.BAR_TS;
    const { view } = liveSubject(BAR_SUBJECT, fields, null);
    expect(formingBarFrom(view())).toBeNull();
  });
});

describe('liveBindings (§11.5)', () => {
  it('finds every ChartSeries.live binding, in series order', () => {
    expect(liveBindings(makeSpec({ quoteLine: true }))).toEqual([
      { seriesId: 'p', subject: BAR_SUBJECT, field: 'PX_LAST', mode: 'append-forming-bar' },
      { seriesId: 'last', subject: QUOTE_SUBJECT, field: 'PX_LAST', mode: 'replace-last' },
    ]);
  });

  it('finds none in a spec with no live series', () => {
    const spec = makeSpec();
    delete spec.series[0]?.live;
    expect(liveBindings(spec)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The product path: one frame in, the drawn columns out                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * A study that keeps the `StudyInput` it was handed — the test's window onto the growable columns.
 *
 * The suites below assert §11.5's three rules against the arrays the chart DRAWS FROM, which are
 * `Renderer`'s, and the renderer publishes no accessor for them. It does hand every column to a
 * study, and it recomputes the studies on every applied patch (`updateStudiesFor`), so a recording
 * study is an honest observation point: `seen.high[315]` after a tick is the high the candle for slot
 * 315 will be drawn from. The alternative — a second set of columns inside `streaming.ts`, asserted
 * on its own — is what this file used to do, and the chart used none of it.
 */
function recorder(): { def: StudyDef; seen: () => StudyInput } {
  let last: StudyInput | null = null;
  const def: StudyDef = {
    id: 'REC',
    name: 'Recorder',
    pane: 'sub',
    params: [],
    needs: ['ohlc', 'volume'],
    compute: (input) => {
      last = input;
      return { lines: [{ id: 'rec', label: 'rec', y: input.close, style: { color: 'auto' } }] };
    },
  };
  return {
    def,
    seen: () => {
      if (last === null) throw new Error('the recording study was never computed');
      return last;
    },
  };
}

/** One spec, one renderer, one stream — the three the component wires together (§11.5). */
function mount(spec: ChartSpec): {
  renderer: Renderer;
  stream: ChartStream;
  deliver: (e: UpdateEvent) => LiveUpdate[];
  seen: () => StudyInput;
  valueAt: (seriesId: string, slot: number) => number;
} {
  const rec = recorder();
  const withStudy: ChartSpec = {
    ...spec,
    panes: [...spec.panes, { id: 'REC', height: 0.2 }],
    studies: [{ id: 'REC', params: {}, pane: 'REC', inputSeriesId: 'p' }],
  };
  const base = document.createElement('canvas');
  const overlay = document.createElement('canvas');
  const renderer = new Renderer(base, overlay, { dpr: 1, theme: THEME, fonts: FONTS });
  renderer.resize(600, 400, 1);
  renderer.setPlugins({ studies: { REC: rec.def } });
  renderer.setSpec(withStudy);
  const stream = new ChartStream(withStudy);
  return {
    renderer,
    stream,
    // Exactly what `ChartCanvas`'s live effect does with a frame, minus the DOM: decode, then apply
    // to the renderer that owns the columns.
    deliver: (e) => {
      const updates = stream.updatesFrom(e);
      for (const update of updates) renderer.applyStream(update.patch);
      return updates;
    },
    seen: rec.seen,
    valueAt: (seriesId, slot) => renderer.valueOfSeriesAtSlot(seriesId, slot),
  };
}

/** A theme and fonts for a renderer nothing measures: no pixel in this file is asserted. */
const THEME: ChartTheme = {
  name: 'dark',
  colour: Object.fromEntries(COLOUR_TOKENS.map((t) => [t, '#303030'])) as Record<ColourToken, string>,
};
const FONTS: ChartFonts = {
  axis: '11px monospace',
  label: '11px monospace',
  readout: '11px monospace',
  lineHeightPx: 13,
  digitPx: 6.6,
};

describe('append-forming-bar: the last slot is overwritten in place (§11.5)', () => {
  it('rewrites the last element of every column and grows nothing', () => {
    const chart = mount(makeSpec());
    const bar = lastBar();

    const tick = liveSubject(
      BAR_SUBJECT,
      { ...barFields(bar, false), PX_LAST: bar.close + 0.5, PX_HIGH: bar.high + 0.5 },
      bar.barTs,
    );
    const applied = chart.deliver(tick.snapEvent());

    expect(applied).toHaveLength(1);
    expect(applied[0]?.patch.mode).toBe('append-forming-bar');
    // The drawn columns, read through the study the renderer feeds: the close and the high moved and
    // the slot count did not, which is what "in place" means.
    expect(chart.seen().close[315]).toBe(bar.close + 0.5);
    expect(chart.seen().high?.[315]).toBe(bar.high + 0.5);
    expect(chart.seen().close).toHaveLength(316);
    expect(chart.valueAt('p', 315)).toBe(bar.close + 0.5);
    // No slot was added: slot 316 does not exist, and the viewport still ends at 315.
    expect(chart.valueAt('p', 316)).toBeNaN();
    expect(chart.renderer.state().view.slot1).toBe(315);
  });

  it('refuses a bar whose BAR_TS is behind the last slot (GIP/resolve.ts#formingBarOf)', () => {
    const chart = mount(makeSpec());
    const bar = lastBar();
    const before = chart.valueAt('p', 315);

    const stale = liveSubject(
      BAR_SUBJECT,
      { ...barFields(bar, false), BAR_TS: bar.barTs - MINUTE_MS, PX_LAST: 1 },
      bar.barTs - MINUTE_MS,
    );
    // The frame decodes — it is a valid bar — and the renderer refuses to apply it, because the slot
    // axis every binary search depends on must stay sorted and an earlier minute redrawn with newer
    // numbers is the plant being behind the store.
    expect(chart.deliver(stale.snapEvent())).toHaveLength(1);
    expect(chart.valueAt('p', 315)).toBe(before);
    expect(chart.valueAt('p', 316)).toBeNaN();
    expect(chart.seen().close).toHaveLength(316);
  });
});

describe('append-forming-bar: a new BAR_TS grows the arrays by doubling (§11.5)', () => {
  it('doubles the capacity once and then appends into the room it made', () => {
    const chart = mount(makeSpec());
    const bar = lastBar();
    const subject = liveSubject(BAR_SUBJECT, barFields(bar, false), bar.barTs);
    const capacityOf = (column: Float64Array): number => column.buffer.byteLength / 8;
    const bufferOf = (column: Float64Array): ArrayBufferLike => column.buffer;
    expect(capacityOf(chart.seen().close)).toBe(316);

    const minute = (n: number): UpdateEvent =>
      subject.push(
        {
          BAR_TS: bar.barTs + n * MINUTE_MS,
          PX_OPEN: bar.close,
          PX_HIGH: bar.close + n,
          PX_LOW: bar.close - n,
          PX_LAST: bar.close + n / 2,
          PX_VOLUME: 1_000 * n,
          IS_FINAL: false,
        },
        bar.barTs + n * MINUTE_MS,
      );

    chart.deliver(minute(1));
    expect(chart.seen().close).toHaveLength(317);
    expect(chart.valueAt('p', 316)).toBe(bar.close + 0.5);
    expect(capacityOf(chart.seen().close)).toBe(632);
    const grown = bufferOf(chart.seen().close);

    chart.deliver(minute(2));
    expect(chart.seen().close).toHaveLength(318);
    expect(chart.valueAt('p', 317)).toBe(bar.close + 1);
    // The assertion that makes "capacity doubling" mean something: the second append reallocated
    // NOTHING. A grow-by-one implementation copies 318 doubles here and passes every other
    // assertion in this file.
    expect(capacityOf(chart.seen().close)).toBe(632);
    expect(bufferOf(chart.seen().close)).toBe(grown);
    // And the columns handed to a draw function are `subarray(0, used)` of that buffer, so nothing
    // can read the slack: 318 bars, not a tail of NaN out to 632.
    expect(chart.seen().high?.[317]).toBe(bar.close + 2);
    expect(chart.seen().volume?.[317]).toBe(2_000);
    expect(chart.seen().volume).toHaveLength(318);
    // The slot axis grew with them (§11.5: "a slot is added to the TradingDayIndex"), and the
    // viewport followed the right edge it was already pinned to.
    expect(chart.renderer.state().view.slot1).toBe(317);
  });
});

describe('final:true freezes the bar (§11.5, the WP-14 acceptance row)', () => {
  it('applies the sealing frame and then ignores the same BAR_TS forever', () => {
    const chart = mount(makeSpec());
    const bar = lastBar();
    const sealedClose = bar.close + 1.25;

    const subject = liveSubject(
      BAR_SUBJECT,
      { ...barFields(bar, false), PX_LAST: sealedClose },
      bar.barTs,
    );
    chart.deliver(subject.snapEvent());
    expect(chart.valueAt('p', 315)).toBe(sealedClose);

    chart.deliver(subject.push({ IS_FINAL: true }, bar.barTs));
    expect(chart.valueAt('p', 315)).toBe(sealedClose);

    // The conflated repeat the plant is entitled to send: same BAR_TS, a later price. A sealed
    // minute is history, and history does not move.
    chart.deliver(subject.push({ PX_LAST: sealedClose + 9 }, bar.barTs));
    expect(chart.valueAt('p', 315)).toBe(sealedClose);
    expect(chart.seen().close[315]).toBe(sealedClose);

    // The NEXT minute still opens normally: sealing is about one slot, not about the series.
    chart.deliver(
      subject.push(
        { BAR_TS: bar.barTs + MINUTE_MS, PX_LAST: 331, IS_FINAL: false },
        bar.barTs + MINUTE_MS,
      ),
    );
    expect(chart.valueAt('p', 316)).toBe(331);
  });
});

describe('replace-last (§11.5)', () => {
  it('rewrites the last y of the bound series and leaves the candle columns alone', () => {
    const chart = mount(makeSpec({ quoteLine: true }));
    const bar = lastBar();
    const candleClose = chart.seen().close[315];

    const quote = liveSubject(QUOTE_SUBJECT, { PX_LAST: bar.close + 2 }, CAPTURED_AT);
    const applied = chart.deliver(quote.snapEvent());

    expect(applied).toHaveLength(1);
    expect(applied[0]?.patch.seriesId).toBe('last');
    expect(chart.valueAt('last', 315)).toBe(bar.close + 2);
    // A q: last price is not a bar: folding it into `c` would leave a candle disagreeing with its
    // own high on the next b1m: frame.
    expect(chart.seen().close[315]).toBe(candleClose);
    expect(chart.valueAt('p', 315)).toBe(candleClose);
  });

  it('leaves the bar of a CANDLE series bound to q: untouched', () => {
    // The case the previous test cannot reach: the series carrying the ohlc columns is itself the one
    // the last price lands on. Folding a q: print into the bar would leave a candle whose close
    // disagreed with its own high on the next b1m: frame — a body drawn outside its own wick.
    //
    // `open`/`high`/`low` are what this can observe: `StudyInput.close` IS the series' `y` column
    // (`Renderer.studyInput`), so the ohlc close has no separate reader on the study seam. A
    // `replace-last` that wrote the whole bar fails on the other three, which is the behaviour at
    // issue; a `replace-last` that wrote ONLY `c` would not be caught here and is recorded as such.
    const chart = mount(makeSpec({ candleOnQuote: true }));
    const bar = lastBar();
    const openBefore = chart.seen().open?.[315];
    const highBefore = chart.seen().high?.[315];
    const lowBefore = chart.seen().low?.[315];

    const quote = liveSubject(QUOTE_SUBJECT, { PX_LAST: bar.close + 4 }, CAPTURED_AT);
    chart.deliver(quote.snapEvent());

    expect(chart.valueAt('p', 315)).toBe(bar.close + 4);
    expect(chart.seen().open?.[315]).toBe(openBefore);
    expect(chart.seen().high?.[315]).toBe(highBefore);
    expect(chart.seen().low?.[315]).toBe(lowBefore);
    // The bar is unchanged and the LINE value moved, which is the split §11.5 asks for: the legend
    // and the `y` follow the last print, the candle waits for its next `b1m:` frame.
    expect(chart.seen().high?.[315]).toBe(bar.high);
  });

  it('fans one subject out to every series bound to it', () => {
    const chart = mount(makeSpec({ barLine: true }));
    const bar = lastBar();
    const tick = liveSubject(
      BAR_SUBJECT,
      { ...barFields(bar, false), PX_LAST: bar.close + 3 },
      bar.barTs,
    );
    const applied = chart.deliver(tick.snapEvent());
    expect(applied.map((a) => a.patch.seriesId)).toEqual(['p', 'close']);
    expect(chart.valueAt('p', 315)).toBe(bar.close + 3);
    expect(chart.valueAt('close', 315)).toBe(bar.close + 3);
  });

  it('produces no patch for a subject nothing is bound to', () => {
    const chart = mount(makeSpec());
    const other = liveSubject('q:999', { PX_LAST: 1 }, CAPTURED_AT);
    expect(chart.deliver(other.snapEvent())).toEqual([]);
    expect(chart.valueAt('p', 315)).toBe(lastBar().close);
  });
});

describe('the staleness verdict travels with the patch (TERM-12)', () => {
  it('reports the subject st the cache computed, not "live" by default', () => {
    // WP-13 shipped a gap grey that reached no reader, so cells went on saying "live" about numbers
    // the client had refused. A forming bar drawn off a subject the 1 s sweep has ruled stale must
    // not be legended as live either, and the legend is handed this, not the cache.
    const chart = mount(makeSpec());
    const bar = lastBar();
    const subject = liveSubject(BAR_SUBJECT, barFields(bar, false), bar.barTs);

    const event = subject.snapEvent();
    expect(chart.deliver(event)[0]?.st).toBe('live');

    // A second later the sweep runs, with the real `core/quote/staleness.ts#valueState` — an hour
    // after the capture, nothing on this subject is live any more. `UpdateEvent.state` is the cache's
    // own `QuoteView` object, so the verdict lands on the view the chart already holds; the chart
    // READS it and never recomputes it.
    const moved = subject.cache.sweep(CAPTURED_AT + 3_600_000);
    expect(moved).toEqual([BAR_SUBJECT]);
    expect(event.state.st).toBe('stale');
    expect(chart.deliver(event)[0]?.st).toBe('stale');
  });

  it('carries a verdict for every patch of a fan-out, so no legend value is left unsaid', () => {
    const chart = mount(makeSpec({ barLine: true }));
    const bar = lastBar();
    const subject = liveSubject(BAR_SUBJECT, barFields(bar, false), bar.barTs);
    const event = subject.snapEvent();
    subject.cache.sweep(CAPTURED_AT + 3_600_000);
    const applied = chart.deliver(event);
    // Two series on one subject, two patches, two verdicts: `st` is not optional on a `LiveUpdate`,
    // because a patch exists only because a frame arrived and that frame had a verdict. The legend
    // writes `data-st` per series (`ChartCanvas.paintFurniture`), so a patch with no verdict would be
    // a value left claiming to be live.
    expect(applied.map((a) => a.st)).toEqual(['stale', 'stale']);
  });
});

describe('auto-follow (§11.5)', () => {
  const pinned: Viewport = { slot0: 215, slot1: 315 };

  it('pins the viewport to the new last slot when the right edge was on it', () => {
    expect(followOnAppend(pinned, 315, 1)).toEqual({ slot0: 216, slot1: 316 });
  });

  it('leaves a scrolled-back viewport untouched, by identity', () => {
    // Identity, not equality: the renderer skips marking the base canvas dirty when the view object
    // did not change, so a chart the user scrolled back to March must not even look like it moved.
    const scrolled: Viewport = { slot0: 100, slot1: 200 };
    expect(followOnAppend(scrolled, 315, 1)).toBe(scrolled);
  });

  it('follows a right edge a hair short of the last slot, and not one half a bar short', () => {
    // The tolerance exists for a viewport that reached the end through fractional zooms. It is a
    // millionth of a slot: half a bar short is a user looking backwards, and that must not follow.
    expect(followOnAppend({ slot0: 215, slot1: 315 - 1e-9 }, 315, 1)).toEqual({
      slot0: 215 + 1,
      slot1: 316 - 1e-9,
    });
    const halfABarBack: Viewport = { slot0: 214.5, slot1: 314.5 };
    expect(followOnAppend(halfABarBack, 315, 1)).toBe(halfABarBack);
  });

  it('does nothing when nothing was appended', () => {
    expect(followOnAppend(pinned, 315, 0)).toBe(pinned);
  });

  it('keeps the viewport width across a follow, so a zoom survives a tick', () => {
    const zoomed: Viewport = { slot0: 300.25, slot1: 315 };
    const followed = followOnAppend(zoomed, 315, 1);
    expect(followed.slot1 - followed.slot0).toBeCloseTo(zoomed.slot1 - zoomed.slot0, 12);
  });
});
