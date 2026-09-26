/**
 * `packages/web/test/chart/chartCanvas.test.tsx` — WP-14's component row: the React seam, the
 * twenty-two-study registry join, and the §11.9 keyboard map (CLIENT.md §11.1, §11.6–§11.9;
 * CHRT-01..07, TERM-06, TERM-10, DATA-10).
 *
 * **This file drives the product path.** The specs come from the six screens that build real
 * `ChartSpec`s — `gpChartSpec`, `gipChartSpec` — through the golden payloads those screens are fed in
 * production, so nothing here hand-builds a chart out of shapes no payload produces (WP-12's audit
 * found three defects whose tests could not catch them for exactly that reason). The streamed frames
 * are `snap`/`delta` objects parsed by `wire/ws.ts`'s own zod schemas and applied by the real WP-13
 * `QuoteCache`, so what reaches the component is what the socket would deliver.
 *
 * The frame pump is `test/setup.tsx`'s (TESTING.md §2.2): `requestAnimationFrame` QUEUES and
 * `flushFrames(n)` runs n frames. No `setTimeout` waiting appears below. jsdom does not lay out, so
 * `getBoundingClientRect` is stubbed to one fixed box — every pane rect, hit test and pixel in this
 * file is measured against that box and nothing else.
 *
 * One deliberate edit to a real spec, in ONE test. Every golden payload in this build cites a single
 * source, so every series of every fixture spec carries `provIdx: 0`; DATA-10's multi-source case —
 * the one where the attribute has to MOVE as the crosshair moves — cannot be expressed by any of them.
 * The `provIdx` values are therefore relabelled 0,1,2 on the real GIP spec and nothing else about it
 * is touched, which is what a GP with two overlays from two vendors would actually produce.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Profiler } from 'react';
import type { ProfilerOnRenderCallback, ReactElement } from 'react';

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { manifests } from '@terminal/core';
import type { FunctionCode, ParamsOf, PayloadOf } from '@terminal/core';
import { Delta as DeltaSchema, QuoteCache, Snap as SnapSchema } from '@terminal/sdk';
import type { Delta, FieldValue, Snap, UpdateEvent, ValueState } from '@terminal/sdk';

import { ChartCanvas, ChartLiveContext, chartKeyAction, cyclableTypes } from '../../src/chart/ChartCanvas.js';
import type { ChartLiveSource, ChartParamsPatch } from '../../src/chart/ChartCanvas.js';
import { DRAW_KIND_KEY, ZOOM_STEP } from '../../src/chart/ChartCanvas.js';
import { defaultParams, studies, studyList } from '../../src/chart/studies/index.js';
import { STUDY_IDS } from '../../src/chart/studies/types.js';
import { DRAW_MODES, DRAW_MODE_LABEL } from '../../src/chart/types.js';
import type { ChartSpec } from '../../src/chart/types.js';
import { ScreenActionsContext } from '../../src/screen/widgets/registry.js';
import type { ScreenActions, WidgetRegistry } from '../../src/screen/widgets/registry.js';
import { gipChartSpec } from '../../src/screens/GIP/Screen.js';
import { gpChartSpec } from '../../src/screens/GP/Screen.js';
import { flushFrames } from '../setup.js';

/* ── fixtures ───────────────────────────────────────────────────────────────────────────────── */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(TEST_DIR))));
const PAYLOADS = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

function payload<C extends FunctionCode>(name: string): PayloadOf<C> {
  return JSON.parse(readFileSync(join(PAYLOADS, name), 'utf8')) as PayloadOf<C>;
}

function defaults<C extends FunctionCode>(code: C): ParamsOf<C> {
  return manifests[code].params.parse({}) as ParamsOf<C>;
}

/** GIP: 311 one-minute bars, a candle series with a `b1m:` binding, a VWAP line, a volume pane. */
const gipSpec = (): ChartSpec => gipChartSpec(payload<'GIP'>('GIP.intraday.json'), defaults('GIP'));

/** GP: 11 daily bars and two corporate-action markers — the event band's own fixture (CHRT-06). */
const gpSpec = (): ChartSpec => gpChartSpec(payload<'GP'>('GP.equity.json'), defaults('GP'));

/**
 * The same GIP spec with a WIRE-VALID live subject, and the second deliberate edit in this file.
 *
 * `GIP/Screen.tsx` builds `b1m:${instrument.instrumentId}`, and `GIP.intraday.json` carries
 * `instrumentId: "<AAPL>"` — a redacted placeholder — so the subject that fixture yields is
 * `b1m:<AAPL>`, which `wire/ws.ts`'s subject pattern rejects. No frame for it can exist, and a test
 * that hand-built a `QuoteView` to get round that would be proving a capability against an object no
 * payload produces. So the binding is repointed at `b1m:4242` and nothing else is touched. (Reported:
 * a golden payload whose `instrumentId` cannot appear in a subject cannot be streamed at all.)
 */
const LIVE_SUBJECT = 'b1m:4242';

function gipStreamingSpec(): ChartSpec {
  const spec = gipSpec();
  return {
    ...spec,
    series: spec.series.map((s) =>
      s.live === undefined ? s : { ...s, live: { ...s.live, subject: LIVE_SUBJECT } },
    ),
  };
}

/* ── the jsdom box ──────────────────────────────────────────────────────────────────────────── */

const BOX_W = 900;
const BOX_H = 500;
const DPR = 2;

const BOX: DOMRect = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: BOX_W,
  bottom: BOX_H,
  width: BOX_W,
  height: BOX_H,
  toJSON: () => ({}),
};

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(BOX);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── mounting ───────────────────────────────────────────────────────────────────────────────── */

interface Harness {
  host: HTMLElement;
  base: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  readout: HTMLElement;
  commits: () => number;
  actions: { navigate: string[]; navigateNext: string[]; provenance: number[] };
  events: { kind: string; payload: unknown }[];
  params: ChartParamsPatch[];
  overlays: string[];
  /** `data-view`, as the two numbers it carries. */
  view: () => { slot0: number; slot1: number };
  span: () => number;
  provIdx: () => number;
  key: (init: KeyboardEventInit) => boolean;
  unmount: () => void;
}

function mount(spec: ChartSpec, live: ChartLiveSource | null = null): Harness {
  const navigate: string[] = [];
  const navigateNext: string[] = [];
  const provenance: number[] = [];
  const events: { kind: string; payload: unknown }[] = [];
  const params: ChartParamsPatch[] = [];
  const overlays: string[] = [];
  const actions: ScreenActions = {
    navigate: (c) => navigate.push(c),
    navigateNext: (c) => navigateNext.push(c),
    openUrl: () => undefined,
    provenance: (i) => provenance.push(i),
  };

  let commits = 0;
  const onRender: ProfilerOnRenderCallback = () => {
    commits += 1;
  };

  const tree: ReactElement = (
    <ChartLiveContext.Provider value={live}>
      <ScreenActionsContext.Provider value={actions}>
        <Profiler id="chart" onRender={onRender}>
          <ChartCanvas
            id="chart1"
            spec={spec}
            dpr={DPR}
            instrumentId={4242}
            onEvent={(e) => events.push({ kind: e.kind, payload: e.payload })}
            onParamsChange={(patch) => params.push(patch)}
            onOverlayRequest={(q) => overlays.push(q)}
          />
        </Profiler>
      </ScreenActionsContext.Provider>
    </ChartLiveContext.Provider>
  );

  const view = render(tree);
  const host = view.container.querySelector<HTMLElement>('.chart');
  const base = view.container.querySelector<HTMLCanvasElement>('canvas.chart__base');
  const overlay = view.container.querySelector<HTMLCanvasElement>('canvas.chart__overlay');
  const readout = view.container.querySelector<HTMLElement>('.chart__readout');
  if (host === null || base === null || overlay === null || readout === null) {
    throw new Error('ChartCanvas did not render its host, its two canvases and its readout');
  }
  host.focus();
  flushFrames(4);

  const readView = (): { slot0: number; slot1: number } => {
    const raw = host.dataset.view ?? '';
    const [a, b] = raw.split(':');
    return { slot0: Number(a), slot1: Number(b) };
  };

  return {
    host,
    base,
    overlay,
    readout,
    commits: () => commits,
    actions: { navigate, navigateNext, provenance },
    events,
    params,
    overlays,
    view: readView,
    span: () => readView().slot1 - readView().slot0,
    provIdx: () => Number(host.dataset.provIdx),
    key: (init) => {
      const delivered = fireEvent.keyDown(host, init);
      flushFrames(4);
      return delivered;
    },
    unmount: view.unmount,
  };
}

/* ── a real frame, for the streaming test ───────────────────────────────────────────────────── */

const CAPTURED_AT = 1_789_497_950_000;
const MINUTE_MS = 60_000;

function snapFrame(subject: string, f: Record<string, FieldValue>, srcTs: number): Snap {
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
    id: 4242,
  });
}

function deltaFrame(
  subject: string,
  seq: number,
  f: Record<string, FieldValue>,
  srcTs: number,
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

function barFields(t: number, close: number, final: boolean): Record<string, FieldValue> {
  return {
    BAR_TS: t,
    PX_OPEN: close - 0.05,
    PX_HIGH: close + 0.08,
    PX_LOW: close - 0.09,
    PX_LAST: close,
    PX_VOLUME: 1_000,
    IS_FINAL: final,
  };
}

/**
 * A live source that records what was subscribed and lets the test push real frames through a real
 * `QuoteCache`, exactly as `rt/wsBridge.ts` would fan them out.
 */
function liveHarness(subject: string, firstBarTs: number, firstClose: number) {
  const cache = new QuoteCache();
  const subscribed: { subjects: readonly string[]; fields: readonly string[] }[] = [];
  const handlers: ((e: UpdateEvent) => void)[] = [];
  let seq = 1;
  cache.apply(snapFrame(subject, barFields(firstBarTs, firstClose, false), firstBarTs));

  const sweeps: ((states: ReadonlyMap<string, ValueState>) => void)[] = [];
  const source: ChartLiveSource = {
    subscribe: (subjects, fields, onUpdate) => {
      subscribed.push({ subjects: [...subjects], fields: [...fields] });
      handlers.push(onUpdate);
      return () => {
        const at = handlers.indexOf(onUpdate);
        if (at >= 0) handlers.splice(at, 1);
      };
    },
    // The 1 s staleness sweep is the SOURCE's, as `rt/wsBridge.ts` owns it for the grid: the bridge
    // calls `QuoteCache.sweep()` — the real `core/quote/staleness.ts#valueState` — and reports the
    // subjects whose verdict changed. This fake is that bridge, so the test drives a second without
    // waiting for one (TESTING.md §2.2: no web test waits on `setTimeout`).
    onStaleness: (handler) => {
      sweeps.push(handler);
      return () => {
        const at = sweeps.indexOf(handler);
        if (at >= 0) sweeps.splice(at, 1);
      };
    },
  };

  let last: UpdateEvent | null = null;

  return {
    source,
    subscribed,
    handlerCount: () => handlers.length,
    sweepCount: () => sweeps.length,
    /** Age the real cache WITHOUT telling the chart — the frame that follows carries the verdict. */
    sweepAge: (nowMs: number = CAPTURED_AT + 3_600_000): void => {
      cache.sweep(nowMs);
    },
    /** Age the real cache and tell the chart what its own sweep would have told it. */
    age: (nowMs: number): void => {
      const changed = cache.sweep(nowMs);
      const states = new Map<string, ValueState>();
      for (const s of changed) {
        const view = cache.get(s);
        if (view !== undefined) states.set(s, view.st);
      }
      act(() => {
        for (const handler of [...sweeps]) handler(states);
        flushFrames(2);
      });
    },
    /** Deliver the last frame again — its `state` is the cache's own object, so a sweep shows in it. */
    redeliver: (): void => {
      const event = last;
      if (event === null) throw new Error('nothing has been pushed yet');
      act(() => {
        for (const handler of [...handlers]) handler(event);
        flushFrames(3);
      });
    },
    /**
     * Push one forming-bar delta and deliver the `UpdateEvent` to every handler.
     *
     * Inside `act`, and that is load-bearing for the zero-commit assertion rather than boilerplate.
     * A `setState` called from a plain callback in a test environment is SCHEDULED and not flushed —
     * `commits` would not move even for a component that re-rendered on every tick, so the assertion
     * would hold no matter what the component did. `act` flushes whatever was scheduled, which is what
     * makes "zero commits" a claim about the component instead of about React's test scheduler.
     * (Verified by mutation: a `setState` added to the stream path fails the test with this here, and
     * passes without it.)
     */
    push: (t: number, close: number, final = false): void => {
      seq += 1;
      const result = cache.apply(deltaFrame(subject, seq, barFields(t, close, final), t));
      expect(result.resyncNeeded, 'the delta chain broke — the test built a bad frame').toBe(false);
      const state = cache.get(subject);
      if (state === undefined) throw new Error(`cache lost ${subject}`);
      const event: UpdateEvent = { subject, seq, changed: result.changed, state, kind: 'delta' };
      last = event;
      act(() => {
        for (const handler of [...handlers]) handler(event);
        flushFrames(3);
      });
    },
  };
}

/* ============================================================================================= */
/* 1. The registry join (studies/index.ts)                                                        */
/* ============================================================================================= */

describe('the study registry (CLIENT.md §11.6, CHRT-04)', () => {
  it('registers all twenty-two ids, and every key is its own StudyDef.id', () => {
    expect(STUDY_IDS).toHaveLength(22);
    expect(Object.keys(studies)).toHaveLength(22);
    // The key is how the picker and a persisted layout address a study; `def.id` is what the pane and
    // the legend are labelled from. A copy-paste that left `ATR`'s id on a new study would pass a
    // count test and fail this one.
    for (const [key, def] of Object.entries(studies)) {
      expect(def.id, `registered under ${key}`).toBe(key);
    }
    expect(Object.keys(studies).sort()).toEqual([...STUDY_IDS].sort());
  });

  it('splits nine main overlays and thirteen sub panes, in §11.6 order', () => {
    const main = studyList.filter((def) => def.pane === 'main').map((def) => def.id);
    const sub = studyList.filter((def) => def.pane === 'sub').map((def) => def.id);
    expect(main).toEqual(['SMA', 'EMA', 'WMA', 'BB', 'DONCHIAN', 'KELTNER', 'PSAR', 'ICHIMOKU', 'VWAP']);
    expect(sub).toEqual([
      'VOL',
      'RSI',
      'MACD',
      'STOCH',
      'ATR',
      'ADX',
      'CCI',
      'WILLR',
      'ROC',
      'MOM',
      'OBV',
      'STDDEV',
      'HVOL',
    ]);
    expect(studyList.map((def) => def.id)).toEqual([...STUDY_IDS]);
  });

  it('carries §11.6’s parameter defaults, and every default is inside its own min/max', () => {
    // The whole table, because a default is a number a user never types and therefore never checks.
    expect(defaultParams(studies.SMA)).toEqual({ n: 20 });
    expect(defaultParams(studies.EMA)).toEqual({ n: 20 });
    expect(defaultParams(studies.WMA)).toEqual({ n: 20 });
    expect(defaultParams(studies.BB)).toEqual({ n: 20, k: 2 });
    expect(defaultParams(studies.DONCHIAN)).toEqual({ n: 20 });
    expect(defaultParams(studies.KELTNER)).toEqual({ n: 20, atr: 10, k: 2 });
    expect(defaultParams(studies.PSAR)).toEqual({ af: 0.02, max: 0.2 });
    expect(defaultParams(studies.ICHIMOKU)).toEqual({ tenkan: 9, kijun: 26, senkou: 52 });
    expect(defaultParams(studies.VWAP)).toEqual({ anchor: 0 });
    expect(defaultParams(studies.VOL)).toEqual({ n: 20 });
    expect(defaultParams(studies.RSI)).toEqual({ n: 14 });
    expect(defaultParams(studies.MACD)).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(defaultParams(studies.STOCH)).toEqual({ k: 14, d: 3, smooth: 3 });
    expect(defaultParams(studies.ATR)).toEqual({ n: 14 });
    expect(defaultParams(studies.ADX)).toEqual({ n: 14 });
    expect(defaultParams(studies.CCI)).toEqual({ n: 20 });
    expect(defaultParams(studies.WILLR)).toEqual({ n: 14 });
    expect(defaultParams(studies.ROC)).toEqual({ n: 12 });
    expect(defaultParams(studies.MOM)).toEqual({ n: 10 });
    expect(defaultParams(studies.OBV)).toEqual({});
    expect(defaultParams(studies.STDDEV)).toEqual({ n: 20 });
    expect(defaultParams(studies.HVOL)).toEqual({ n: 30 });

    for (const def of studyList) {
      for (const param of def.params) {
        expect(param.min, `${def.id}.${param.name} min`).toBeLessThanOrEqual(param.default);
        expect(param.max, `${def.id}.${param.name} max`).toBeGreaterThanOrEqual(param.default);
        expect(param.step, `${def.id}.${param.name} step`).toBeGreaterThan(0);
        expect(param.label.length, `${def.id}.${param.name} label`).toBeGreaterThan(0);
      }
      // `needs` is what the picker greys a study out with: a volume study offered on a series with no
      // volume column computes a line of `NaN` and looks like a bug in the maths.
      expect(def.needs.length, `${def.id}.needs`).toBeGreaterThan(0);
    }
  });

  it('computes something finite for every study on a real 311-bar intraday series', () => {
    // The registry's own smoke test: a `compute` that throws, or that returns no line at all, is a
    // study the picker offers and the renderer cannot draw.
    const spec = gipSpec();
    const price = spec.series[0];
    if (price?.ohlc === undefined || price.volume === undefined) {
      throw new Error('the GIP spec no longer carries ohlc and volume');
    }
    const input = {
      x: Float64Array.from(price.x),
      close: Float64Array.from(price.y),
      open: price.ohlc.o,
      high: price.ohlc.h,
      low: price.ohlc.l,
      volume: price.volume,
    };
    for (const def of studyList) {
      const out = def.compute(input, defaultParams(def));
      const values = [
        ...out.lines.flatMap((line) => [...line.y]),
        ...(out.histogram === undefined ? [] : [...out.histogram.y]),
      ];
      expect(out.lines.length + (out.histogram === undefined ? 0 : 1), `${def.id} outputs`).toBeGreaterThan(0);
      expect(values.some((v) => Number.isFinite(v)), `${def.id} produced no finite value`).toBe(true);
    }
  });
});

/* ============================================================================================= */
/* 2. The keyboard table (§11.9)                                                                  */
/* ============================================================================================= */

const QUIET = { drawing: false, modal: false, onEvent: false } as const;

function key(init: Partial<KeyboardEvent> & { key: string; code?: string }) {
  return {
    key: init.key,
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
  };
}

describe('chartKeyAction (CLIENT.md §11.9)', () => {
  /**
   * §11.9's table, row by row, as data — and the reason it is data.
   *
   * The test below used to be called "maps every row of the table" while asserting a hand-written list
   * that omitted the table's LAST row (`V` toggle VWAP; `P` profile view). Neither key had a branch:
   * `V` existed only as draw mode's VLINE letter and `P` was in no keymap at all, so §11.9's profile
   * toggle was reachable from nothing — a TERM-06 gap ("every action above is the same function the key
   * calls") that survived precisely because the title claimed a completeness the body did not check.
   * Enumerating the rows here means a row added to §11.9 and forgotten in `chartKeyAction` fails, and a
   * row deliberately answered somewhere else has to say where.
   */
  const SECTION_11_9: readonly {
    readonly row: string;
    readonly press: Partial<KeyboardEvent> & { key: string; code?: string };
    readonly env?: Partial<{ drawing: boolean; modal: boolean; onEvent: boolean }>;
    /** `null` = deliberately not this component's, with the reason. */
    readonly answered: string | null;
    readonly because?: string;
  }[] = [
    { row: 'ArrowLeft/Right move the crosshair', press: { key: 'ArrowLeft', code: 'ArrowLeft' }, answered: 'crosshair' },
    { row: 'Shift+ArrowLeft/Right pan a tenth', press: { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true }, answered: 'pan' },
    { row: '+/- zoom', press: { key: '+', code: 'Equal', shiftKey: true }, answered: 'zoom' },
    { row: 'Home/End jump', press: { key: 'End', code: 'End' }, answered: 'jump' },
    { row: 'ArrowUp/Down cycle the series', press: { key: 'ArrowUp', code: 'ArrowUp' }, answered: 'cycle-series' },
    { row: 'Alt+ArrowUp/Down cycle the pane', press: { key: 'ArrowDown', code: 'ArrowDown', altKey: true }, answered: 'cycle-pane' },
    {
      row: '1..9 tabs when the screen has them',
      press: { key: '1', code: 'Digit1' },
      answered: null,
      because:
        "§7.2's tab keys belong to the screen, not the chart: `ScreenRenderer` answers them and a chart " +
        'that consumed `1` would swallow the tab switch of every tabbed screen.',
    },
    { row: 'T cycles the series type', press: { key: 't', code: 'KeyT' }, answered: 'cycle-type' },
    { row: 'A cycles adjust', press: { key: 'a', code: 'KeyA' }, answered: 'cycle-adjust' },
    { row: 'N cycles normalise', press: { key: 'n', code: 'KeyN' }, answered: 'cycle-normalise' },
    { row: 'L toggles the log scale', press: { key: 'l', code: 'KeyL' }, answered: 'toggle-log' },
    { row: 'S opens the study picker', press: { key: 's', code: 'KeyS' }, answered: 'picker' },
    { row: 'O opens the overlay picker', press: { key: 'o', code: 'KeyO' }, answered: 'picker' },
    { row: 'E toggles the event band', press: { key: 'e', code: 'KeyE' }, answered: 'toggle-events' },
    { row: 'Ctrl+ArrowLeft/Right step the markers', press: { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }, answered: 'step-event' },
    { row: 'Enter runs a focused marker', press: { key: 'Enter', code: 'Enter' }, env: { onEvent: true }, answered: 'activate' },
    { row: 'D enters draw mode', press: { key: 'd', code: 'KeyD' }, answered: 'toggle-draw' },
    { row: 'Ctrl+S saves the annotations', press: { key: 's', code: 'KeyS', ctrlKey: true }, answered: 'save-annotations' },
    { row: 'Delete removes the selected annotation', press: { key: 'Delete', code: 'Delete' }, answered: 'delete-annotation' },
    { row: 'Space toggles a collapsed sub pane', press: { key: ' ', code: 'Space' }, answered: 'toggle-pane-collapse' },
    {
      row: 'Ctrl+I opens provenance',
      press: { key: 'i', code: 'KeyI', ctrlKey: true },
      answered: null,
      because:
        'RESERVED (`keyboard/keymap.ts`): `ScreenRenderer` answers it from `data-prov-idx`, and a second ' +
        'answer here would drift from the attribute.',
    },
    { row: 'V (GIP) toggles VWAP', press: { key: 'v', code: 'KeyV' }, answered: 'toggle-vwap' },
    { row: 'P (GIP) profile view', press: { key: 'p', code: 'KeyP' }, answered: 'toggle-profile' },
  ];

  it('answers every row of §11.9, or records which other surface does', () => {
    for (const entry of SECTION_11_9) {
      const action = chartKeyAction(key(entry.press), { ...QUIET, ...entry.env });
      if (entry.answered === null) {
        expect(action, `${entry.row} — ${entry.because ?? ''}`).toBeNull();
        expect(entry.because, `${entry.row} declines without saying why`).toBeDefined();
        continue;
      }
      expect(action?.kind, entry.row).toBe(entry.answered);
    }
    // Every action kind the table names is one the component can run: a `ChartKeyAction` with no case
    // in `runAction` is a key that does nothing, which is the same gap one level down.
    expect(new Set(SECTION_11_9.map((e) => e.answered)).size).toBeGreaterThan(15);
  });

  it('maps the individual keys, with the exact values each row implies', () => {
    expect(chartKeyAction(key({ key: 'ArrowLeft', code: 'ArrowLeft' }), QUIET)).toEqual({
      kind: 'crosshair',
      slots: -1,
    });
    expect(chartKeyAction(key({ key: 'ArrowRight', code: 'ArrowRight' }), QUIET)).toEqual({
      kind: 'crosshair',
      slots: 1,
    });
    expect(
      chartKeyAction(key({ key: 'ArrowRight', code: 'ArrowRight', shiftKey: true }), QUIET),
    ).toEqual({ kind: 'pan', fraction: 0.1 });
    expect(
      chartKeyAction(key({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true }), QUIET),
    ).toEqual({ kind: 'pan', fraction: -0.1 });
    expect(chartKeyAction(key({ key: '+', code: 'Equal', shiftKey: true }), QUIET)).toEqual({
      kind: 'zoom',
      factor: ZOOM_STEP,
    });
    expect(chartKeyAction(key({ key: '-', code: 'Minus' }), QUIET)).toEqual({
      kind: 'zoom',
      factor: 1 / ZOOM_STEP,
    });
    expect(chartKeyAction(key({ key: 'Home', code: 'Home' }), QUIET)).toEqual({
      kind: 'jump',
      to: 'start',
    });
    expect(chartKeyAction(key({ key: 'End', code: 'End' }), QUIET)).toEqual({
      kind: 'jump',
      to: 'end',
    });
    expect(chartKeyAction(key({ key: 'ArrowUp', code: 'ArrowUp' }), QUIET)).toEqual({
      kind: 'cycle-series',
      delta: -1,
    });
    expect(chartKeyAction(key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }), QUIET)).toEqual(
      { kind: 'cycle-pane', delta: 1 },
    );
    expect(chartKeyAction(key({ key: 't', code: 'KeyT' }), QUIET)).toEqual({ kind: 'cycle-type' });
    expect(chartKeyAction(key({ key: 'a', code: 'KeyA' }), QUIET)).toEqual({ kind: 'cycle-adjust' });
    expect(chartKeyAction(key({ key: 'n', code: 'KeyN' }), QUIET)).toEqual({
      kind: 'cycle-normalise',
    });
    expect(chartKeyAction(key({ key: 'l', code: 'KeyL' }), QUIET)).toEqual({ kind: 'toggle-log' });
    expect(chartKeyAction(key({ key: 's', code: 'KeyS' }), QUIET)).toEqual({
      kind: 'picker',
      which: 'study',
    });
    expect(chartKeyAction(key({ key: 'o', code: 'KeyO' }), QUIET)).toEqual({
      kind: 'picker',
      which: 'overlay',
    });
    expect(chartKeyAction(key({ key: 'e', code: 'KeyE' }), QUIET)).toEqual({ kind: 'toggle-events' });
    expect(chartKeyAction(key({ key: 'd', code: 'KeyD' }), QUIET)).toEqual({ kind: 'toggle-draw' });
    expect(chartKeyAction(key({ key: ' ', code: 'Space' }), QUIET)).toEqual({
      kind: 'toggle-pane-collapse',
    });
    expect(
      chartKeyAction(key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }), QUIET),
    ).toEqual({ kind: 'step-event', delta: 1 });
    expect(chartKeyAction(key({ key: 's', code: 'KeyS', ctrlKey: true }), QUIET)).toEqual({
      kind: 'save-annotations',
    });
    expect(chartKeyAction(key({ key: 'Delete', code: 'Delete' }), QUIET)).toEqual({
      kind: 'delete-annotation',
    });
    expect(chartKeyAction(key({ key: 'v', code: 'KeyV' }), QUIET)).toEqual({ kind: 'toggle-vwap' });
    expect(chartKeyAction(key({ key: 'p', code: 'KeyP' }), QUIET)).toEqual({ kind: 'toggle-profile' });
    // ...and draw mode still owns the same two letters, which is why `V` could not be the VWAP key
    // before the branch order was settled: `V` is VLINE while `D` is active (§11.8).
    const drawing = { drawing: true, modal: false, onEvent: false } as const;
    expect(chartKeyAction(key({ key: 'v', code: 'KeyV' }), drawing)).toEqual({
      kind: 'draw-kind',
      mode: 'vline',
    });
  });

  it('declines the reserved keys, so the panel dispatcher still answers them', () => {
    // `Ctrl+I` above all: `ScreenRenderer` answers provenance from `data-prov-idx`, and a chart that
    // consumed the key would give a second answer that could drift from the attribute.
    for (const reserved of [
      key({ key: 'i', code: 'KeyI', ctrlKey: true }),
      key({ key: 'p', code: 'KeyP', ctrlKey: true }),
      key({ key: 'e', code: 'KeyE', ctrlKey: true }),
      key({ key: 'l', code: 'KeyL', ctrlKey: true }),
      key({ key: 'Tab', code: 'Tab' }),
      key({ key: 'F1', code: 'F1' }),
      key({ key: 'PageDown', code: 'PageDown' }),
      key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }),
    ]) {
      expect(chartKeyAction(reserved, QUIET), JSON.stringify(reserved)).toBeNull();
    }
    // `Escape` and a bare `Enter` are declined too when the chart owns nothing to cancel or activate.
    expect(chartKeyAction(key({ key: 'Escape', code: 'Escape' }), QUIET)).toBeNull();
    expect(chartKeyAction(key({ key: 'Enter', code: 'Enter' }), QUIET)).toBeNull();
    expect(chartKeyAction(key({ key: 'Enter', code: 'Enter' }), { ...QUIET, onEvent: true })).toEqual({
      kind: 'activate',
      nextPanel: false,
    });
  });

  it('gives the letters to the draw kinds while draw mode is on (§11.8)', () => {
    const drawing = { drawing: true, modal: false, onEvent: false } as const;
    for (const mode of DRAW_MODES) {
      const letter = DRAW_KIND_KEY[mode];
      expect(
        chartKeyAction(key({ key: letter.toLowerCase(), code: `Key${letter}` }), drawing),
        `${DRAW_MODE_LABEL[mode]} is ${letter}`,
      ).toEqual({ kind: 'draw-kind', mode });
    }
    // The same letter means something else when draw mode is off, which is the whole point of the
    // branch: `T` is TREND while drawing and "cycle the series type" otherwise.
    expect(chartKeyAction(key({ key: 't', code: 'KeyT' }), QUIET)).toEqual({ kind: 'cycle-type' });
    expect(chartKeyAction(key({ key: 'Escape', code: 'Escape' }), drawing)).toEqual({ kind: 'cancel' });
    expect(chartKeyAction(key({ key: 'Enter', code: 'Enter' }), drawing)).toEqual({
      kind: 'activate',
      nextPanel: false,
    });
  });

  it('answers nothing but Escape while a picker is open', () => {
    const modal = { drawing: false, modal: true, onEvent: false } as const;
    expect(chartKeyAction(key({ key: 's', code: 'KeyS' }), modal)).toBeNull();
    expect(chartKeyAction(key({ key: 'ArrowRight', code: 'ArrowRight' }), modal)).toBeNull();
    expect(chartKeyAction(key({ key: 'Escape', code: 'Escape' }), modal)).toEqual({ kind: 'cancel' });
  });
});

/* ============================================================================================= */
/* 3. The component                                                                               */
/* ============================================================================================= */

describe('ChartCanvas mounting (§11.1, TERM-10)', () => {
  it('satisfies the WidgetRegistry contract', () => {
    // A compile-time assertion with a runtime witness: `ChartCanvas` takes optional props beyond
    // `ChartCanvasProps`, and this is what proves they stayed optional — a required one would make the
    // assignment below a type error and `widgets/Chart.tsx` would stop compiling.
    const registry: WidgetRegistry = { ChartCanvas };
    expect(registry.ChartCanvas).toBe(ChartCanvas);
  });

  it('sizes both canvases by devicePixelRatio and draws without throwing', () => {
    const h = mount(gipSpec());
    for (const canvas of [h.base, h.overlay]) {
      expect(canvas.width).toBe(BOX_W * DPR);
      expect(canvas.height).toBe(BOX_H * DPR);
      // The CSS box stays the element's: a canvas scaled by the ratio and not laid back down to CSS
      // pixels is a chart drawn twice the size of its panel (TERM-10).
      expect(canvas.style.width).toBe('100%');
    }
    expect(h.view()).toEqual({ slot0: 0, slot1: 310 });
    h.unmount();
  });

  it('renders the legend and the readout as DOM, one tab stop, with the series named', () => {
    const spec = gipSpec();
    const h = mount(spec);
    expect(h.host.tabIndex).toBe(0);
    // One tab stop for the whole widget (CLIENT.md §5.4): the legend is there for the screen reader
    // and the mouse, not as a second stop.
    expect(h.host.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
    const entries = [...h.host.querySelectorAll<HTMLElement>('.chart__legend-entry')];
    expect(entries.map((li) => li.dataset.seriesId)).toEqual(spec.series.map((s) => s.id));
    expect(h.readout.textContent).toContain('No crosshair');
    h.key({ key: 'ArrowLeft', code: 'ArrowLeft' });
    // The readout names every series at the slot (§11.9), and the legend value cells are written
    // imperatively from the same call.
    for (const series of spec.series) expect(h.readout.textContent).toContain(series.label);
    const values = [...h.host.querySelectorAll<HTMLElement>('.chart__legend-value')];
    expect(values.every((cell) => (cell.textContent ?? '') !== '')).toBe(true);
    h.unmount();
  });
});

describe('provenance follows the crosshair (DATA-10, §11.9)', () => {
  it('names the crosshair’s series, and changes as the crosshair changes series', () => {
    const real = gipSpec();
    // The one edit this file makes to a real spec, and only to `provIdx` — see the file header.
    const spec: ChartSpec = { ...real, series: real.series.map((s, i) => ({ ...s, provIdx: i })) };
    expect(new Set(spec.series.map((s) => s.provIdx)).size).toBeGreaterThan(1);

    const h = mount(spec);
    // No crosshair and three sources: -2, "this element cites no provenance". Naming series 0 for the
    // whole canvas would be a false attribution rather than a missing one.
    expect(h.provIdx()).toBe(-2);

    h.key({ key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(h.provIdx()).toBe(0);
    h.key({ key: 'ArrowDown', code: 'ArrowDown' });
    expect(h.provIdx()).toBe(1);
    h.key({ key: 'ArrowDown', code: 'ArrowDown' });
    expect(h.provIdx()).toBe(2);
    h.key({ key: 'ArrowUp', code: 'ArrowUp' });
    expect(h.provIdx()).toBe(1);
    h.unmount();
  });

  it('does not consume Ctrl+I: the screen renderer answers it from the attribute', () => {
    const h = mount(gipSpec());
    h.key({ key: 'ArrowLeft', code: 'ArrowLeft' });
    const notPrevented = fireEvent.keyDown(h.host, { key: 'i', code: 'KeyI', ctrlKey: true });
    expect(notPrevented, 'Ctrl+I must keep bubbling to the reserved handler').toBe(true);
    expect(h.actions.provenance).toEqual([]);
    h.unmount();
  });
});

describe('the viewport keys (§11.9)', () => {
  it('zooms around the crosshair, pans a tenth, and Home/End jump', () => {
    const h = mount(gipSpec());
    const full = h.span();
    expect(full).toBe(310);

    h.key({ key: '+', code: 'Equal', shiftKey: true });
    const zoomed = h.span();
    expect(zoomed).toBeCloseTo(full / ZOOM_STEP, 6);

    const before = h.view();
    h.key({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true });
    const after = h.view();
    expect(after.slot0).toBeCloseTo(before.slot0 - zoomed * 0.1, 1);
    // A pan preserves the span — the clamp translates the window rather than clipping an edge, or
    // panning into a boundary and back would leave the user zoomed in.
    expect(h.span()).toBeCloseTo(zoomed, 1);

    h.key({ key: 'Home', code: 'Home' });
    expect(h.view().slot0).toBe(0);
    expect(h.readout.textContent).not.toContain('No crosshair');

    h.key({ key: 'End', code: 'End' });
    // `End` re-enables auto-follow by putting the right edge back on the last slot (§11.5).
    expect(h.view().slot1).toBe(310);
    expect(h.span()).toBeCloseTo(zoomed, 1);
    h.unmount();
  });

  it('zooms on the wheel through the same function the key calls (TERM-06)', () => {
    const byKey = mount(gipSpec());
    byKey.key({ key: '+', code: 'Equal', shiftKey: true });
    const keySpan = byKey.span();
    byKey.unmount();

    const byWheel = mount(gipSpec());
    fireEvent.wheel(byWheel.host, { deltaY: -120, clientX: 450, clientY: 200 });
    flushFrames(4);
    expect(byWheel.span()).toBeCloseTo(keySpan, 6);

    // And out again, by the same factor: a wheel that zoomed by a different step from `-` would be a
    // second implementation of the same action, which is what TERM-06 forbids.
    fireEvent.wheel(byWheel.host, { deltaY: 120, clientX: 450, clientY: 200 });
    flushFrames(4);
    expect(byWheel.span()).toBeCloseTo(310, 0);
    byWheel.unmount();
  });

  it('pans on a drag through the same function, keeping the span', () => {
    const h = mount(gipSpec());
    h.key({ key: '+', code: 'Equal', shiftKey: true });
    h.key({ key: '+', code: 'Equal', shiftKey: true });
    // `Home` first, because a zoom anchored on the right edge leaves the view AT the right edge and
    // there is nothing there to pan into — the clamp refusing to move is correct, not a defect.
    h.key({ key: 'Home', code: 'Home' });
    const span = h.span();
    const before = h.view();

    fireEvent.mouseDown(h.host, { clientX: 500, clientY: 200 });
    fireEvent.mouseMove(h.host, { clientX: 400, clientY: 200 });
    fireEvent.mouseUp(h.host, { clientX: 400, clientY: 200 });
    flushFrames(4);

    const after = h.view();
    expect(after.slot0).toBeGreaterThan(before.slot0);
    expect(h.span()).toBeCloseTo(span, 1);
    h.unmount();
  });
});

describe('studies, options and panes (§11.6, §11.9)', () => {
  it('opens the study picker on S, adds with defaults on Enter, and reports the params', () => {
    const h = mount(gipSpec());
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();

    h.key({ key: 's', code: 'KeyS' });
    const dialog = h.host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const input = dialog?.querySelector('input');
    if (input === null || input === undefined) throw new Error('the picker has no input');
    // Keyboard-only: focus follows the picker, the typeahead narrows, Enter takes the first row.
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'rsi' } });
    expect(
      [...(dialog?.querySelectorAll('[data-study-option]') ?? [])].map(
        (b) => (b as HTMLElement).dataset.studyOption,
      ),
    ).toEqual(['RSI']);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    flushFrames(4);

    expect(
      [...h.host.querySelectorAll('[data-study-id] .chart__study-label')].map((el) => el.textContent),
    ).toEqual(['RSI']);
    // And the study's VALUE at the crosshair reaches the DOM, which is the only place a screen reader
    // can find it: both canvases are `aria-hidden`, so an RSI that existed only as pixels was a number
    // nothing could read (§11.9's first row).
    h.key({ key: 'End', code: 'End' });
    const value = h.host.querySelector<HTMLElement>('[data-value-of-study="RSI"]');
    expect(value?.textContent ?? '').toMatch(/RSI.*\d/);
    expect(h.readout.textContent ?? '').toContain(value?.textContent ?? 'nothing');
    // The patch is in the shape the SCREEN's own `studies` parameter takes, and it is parsed here with
    // the screen's own zod to prove it: §11.6 routes the study list through `ScreenCtx.setParams`, and
    // `GpParams.studies[].pane` is the enum `main|sub` while a `ChartSpec` study's `pane` is the pane
    // ID. Reporting the spec shape sent every added study to a run request that could not validate it.
    expect(h.params.at(-1)?.studies).toEqual([{ id: 'RSI', params: { n: 14 }, pane: 'sub' }]);
    const round = manifests.GP.params.safeParse({ studies: h.params.at(-1)?.studies });
    expect(round.success, JSON.stringify(round.success ? null : round.error.issues)).toBe(true);
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(h.host);
    h.unmount();
  });

  it('cycles T A N L, applying the three that are client-side and reporting all four', () => {
    const h = mount(gipSpec());
    expect(h.host.dataset.type).toBe('candle');
    h.key({ key: 't', code: 'KeyT' });
    // `SERIES_TYPES` order: candle is followed by ohlc (§11.3).
    expect(h.host.dataset.type).toBe('ohlc');
    expect(h.params.at(-1)).toEqual({ type: 'ohlc' });

    expect(h.host.dataset.normalise).toBe('none');
    h.key({ key: 'n', code: 'KeyN' });
    expect(h.host.dataset.normalise).toBe('pct');
    expect(h.params.at(-1)).toEqual({ normalise: 'pct' });

    expect(h.host.dataset.log).toBe('off');
    h.key({ key: 'l', code: 'KeyL' });
    expect(h.host.dataset.log).toBe('on');
    expect(h.params.at(-1)).toEqual({ logScale: true });

    // `A` is the one that is NOT applied here: an adjusted close is a server-side series. It is
    // recorded on the element and reported, so a host with `setParams` can act on it.
    expect(h.host.dataset.adjust).toBe('on');
    h.key({ key: 'a', code: 'KeyA' });
    expect(h.host.dataset.adjust).toBe('off');
    expect(h.params.at(-1)).toEqual({ adjust: false });
    h.unmount();
  });

  it('collapses a sub pane with Space after Alt+Arrow focuses it, and never the price pane', () => {
    const h = mount(gipSpec());
    // The price pane is pane 0 and is focused first: `Space` there must do nothing, or a key could
    // reach a chart with no price on it.
    h.key({ key: ' ', code: 'Space' });
    expect(h.host.dataset.collapsed ?? '').toBe('');

    h.key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    h.key({ key: ' ', code: 'Space' });
    expect(h.host.dataset.collapsed).toBe('vol');
    h.key({ key: ' ', code: 'Space' });
    expect(h.host.dataset.collapsed).toBe('');
    h.unmount();
  });

  it('collects the overlay picker’s security or formula (CHRT-07)', () => {
    const h = mount(gipSpec());
    h.key({ key: 'o', code: 'KeyO' });
    const input = h.host.querySelector('input');
    if (input === null) throw new Error('the overlay picker has no input');
    fireEvent.change(input, { target: { value: '<RATIO(AAPL US Equity, SPX Index)>' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    flushFrames(2);
    expect(h.overlays).toEqual(['<RATIO(AAPL US Equity, SPX Index)>']);
    h.unmount();
  });
});

describe('the event band (§11.7, CHRT-06)', () => {
  it('toggles on E and steps through the markers with Ctrl+Arrow, Enter running the command', () => {
    const spec = gpSpec();
    const events = spec.events ?? [];
    expect(events.length, 'the GP fixture no longer carries corporate actions').toBeGreaterThan(0);

    const h = mount(spec);
    expect(h.host.dataset.eventBand).toBe('on');
    h.key({ key: 'e', code: 'KeyE' });
    expect(h.host.dataset.eventBand).toBe('off');
    h.key({ key: 'e', code: 'KeyE' });
    expect(h.host.dataset.eventBand).toBe('on');

    h.key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true });
    h.key({ key: 'Enter', code: 'Enter' });
    expect(h.actions.navigate).toHaveLength(1);
    expect(events.map((e) => e.command)).toContain(h.actions.navigate[0]);
    expect(h.events.at(-1)?.kind).toBe('event');

    h.key({ key: 'Enter', code: 'Enter', shiftKey: true });
    expect(h.actions.navigateNext).toHaveLength(1);
    h.unmount();
  });
});

describe('draw mode and annotations (§11.8, CHRT-05)', () => {
  it('draws a trendline from the keyboard and serialises it to the chart_annotations shape', () => {
    const h = mount(gipSpec());
    expect(h.host.dataset.drawMode).toBe('off');
    h.key({ key: 'd', code: 'KeyD' });
    expect(h.host.dataset.drawMode).toBe('trendline');
    expect(h.host.querySelector('[data-draw-footer]')?.textContent).toContain('TREND');

    // Two anchors, placed at two different slots with the crosshair.
    h.key({ key: 'ArrowLeft', code: 'ArrowLeft' });
    h.key({ key: 'Enter', code: 'Enter' });
    h.key({ key: 'ArrowLeft', code: 'ArrowLeft' });
    h.key({ key: 'ArrowLeft', code: 'ArrowLeft' });
    h.key({ key: 'Enter', code: 'Enter' });

    h.key({ key: 's', code: 'KeyS', ctrlKey: true });
    const saved = h.events.filter((e) => e.kind === 'annotation-save').at(-1)?.payload;
    expect(Array.isArray(saved)).toBe(true);
    const records = saved as {
      kind: string;
      anchors: { t: number; v: number }[];
      instrumentId: number;
      sharedScope: string;
      label: string | null;
    }[];
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) throw new Error('no annotation was saved');
    // CHRT-05: the exact `kind` CHECK value, `[{t: epoch_ms, v}]` anchors, integer milliseconds.
    expect(record.kind).toBe('trendline');
    expect(record.anchors).toHaveLength(2);
    for (const anchor of record.anchors) {
      expect(Number.isInteger(anchor.t)).toBe(true);
      expect(Number.isFinite(anchor.v)).toBe(true);
    }
    expect(record.anchors[0]?.t).not.toBe(record.anchors[1]?.t);
    expect(record.instrumentId).toBe(4242);
    expect(record.sharedScope).toBe('private');
    expect(record.label).toBeNull();

    // `Delete` removes the selected annotation, so the next save carries nothing.
    h.key({ key: 'Delete', code: 'Delete' });
    h.key({ key: 's', code: 'KeyS', ctrlKey: true });
    expect(h.events.filter((e) => e.kind === 'annotation-save').at(-1)?.payload).toEqual([]);
    h.unmount();
  });

  it('picks the kind by letter and cancels on Escape', () => {
    const h = mount(gipSpec());
    h.key({ key: 'd', code: 'KeyD' });
    h.key({ key: 'x', code: 'KeyX' });
    expect(h.host.dataset.drawMode).toBe('text');
    h.key({ key: 'f', code: 'KeyF' });
    expect(h.host.dataset.drawMode).toBe('fib');
    h.key({ key: 'c', code: 'KeyC' });
    expect(h.host.dataset.drawMode).toBe('rect');
    h.key({ key: 'Escape', code: 'Escape' });
    expect(h.host.dataset.drawMode).toBe('off');
    // And the letters go back to their §11.9 meanings the moment draw mode ends.
    h.key({ key: 't', code: 'KeyT' });
    expect(h.host.dataset.type).toBe('ohlc');
    h.unmount();
  });

  it('labels the selected annotation through the prompt (§11.8 `L`)', () => {
    const h = mount(gipSpec());
    h.key({ key: 'd', code: 'KeyD' });
    h.key({ key: 'h', code: 'KeyH' });
    h.key({ key: 'ArrowLeft', code: 'ArrowLeft' });
    h.key({ key: 'Enter', code: 'Enter' });
    h.key({ key: 'l', code: 'KeyL' });
    const input = h.host.querySelector('input');
    if (input === null) throw new Error('the label prompt has no input');
    fireEvent.change(input, { target: { value: 'support' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    flushFrames(2);
    h.key({ key: 's', code: 'KeyS', ctrlKey: true });
    const records = h.events.filter((e) => e.kind === 'annotation-save').at(-1)?.payload as {
      kind: string;
      label: string | null;
    }[];
    expect(records.at(-1)).toMatchObject({ kind: 'hline', label: 'support' });
    h.unmount();
  });
});

/* ============================================================================================= */
/* 4. Streaming: zero React commits                                                                */
/* ============================================================================================= */

describe('streaming (§11.5, CHRT-02)', () => {
  it('subscribes exactly what the spec binds, with the seven b1m fields', () => {
    const spec = gipStreamingSpec();
    const binding = spec.series[0]?.live;
    if (binding === undefined) throw new Error('the GIP spec no longer binds a forming bar');
    expect(binding.mode).toBe('append-forming-bar');

    const lastTs = Number(spec.series[0]?.x[310]);
    const live = liveHarness(binding.subject, lastTs, 100);
    const h = mount(spec, live.source);
    expect(live.subscribed).toHaveLength(1);
    expect(live.subscribed[0]?.subjects).toEqual([binding.subject]);
    expect(live.subscribed[0]?.fields).toEqual([
      'BAR_TS',
      'PX_OPEN',
      'PX_HIGH',
      'PX_LOW',
      'PX_LAST',
      'PX_VOLUME',
      'IS_FINAL',
    ]);
    h.unmount();
    // Unmounting unsubscribes: a chart that kept its handler would go on applying patches to a
    // renderer it no longer owns.
    expect(live.handlerCount()).toBe(0);
  });

  it('applies a stream of forming bars with ZERO React commits', () => {
    const spec = gipStreamingSpec();
    const binding = spec.series[0]?.live;
    const xs = spec.series[0]?.x;
    if (binding === undefined || xs === undefined) throw new Error('the GIP spec changed shape');
    const lastTs = Number(xs[310]);

    const live = liveHarness(binding.subject, lastTs, 100);
    const h = mount(spec, live.source);
    // The crosshair goes to the LAST slot, because that is the slot the forming bar rewrites: parked
    // one bar earlier the readout would be right to stay still, and this assertion would prove nothing.
    h.key({ key: 'End', code: 'End' });
    const commitsBefore = h.commits();
    const readoutBefore = h.readout.textContent;

    // Thirty overwrites of the forming bar, then ten appended minutes. This is the path WP-13 shipped
    // a defect on: a React commit here would re-issue `setSpec`, rebuild the slot index and throw away
    // every streamed bar, so "zero commits" is not a performance assertion — it is a correctness one.
    for (let i = 0; i < 30; i += 1) live.push(lastTs, 100 + i * 0.01);
    for (let i = 1; i <= 10; i += 1) live.push(lastTs + i * MINUTE_MS, 101 + i * 0.5);

    expect(h.commits()).toBe(commitsBefore);
    // And the chart did move: the readout is written imperatively from the same frame path, and the
    // appended minutes extended the axis — an assertion that fails if the patches never landed.
    expect(h.readout.textContent).not.toBe(readoutBefore);
    expect(h.view().slot1).toBe(320);
    h.unmount();
  });

  it('follows the right edge on append, and does not when the user has panned away', () => {
    const spec = gipStreamingSpec();
    const binding = spec.series[0]?.live;
    const xs = spec.series[0]?.x;
    if (binding === undefined || xs === undefined) throw new Error('the GIP spec changed shape');
    const lastTs = Number(xs[310]);

    const following = liveHarness(binding.subject, lastTs, 100);
    const a = mount(spec, following.source);
    following.push(lastTs + MINUTE_MS, 101);
    // The right edge was the last slot, so it stayed pinned to the new one (§11.5).
    expect(a.view().slot1).toBe(311);
    a.unmount();

    const parked = liveHarness(binding.subject, lastTs, 100);
    const b = mount(spec, parked.source);
    b.key({ key: '+', code: 'Equal', shiftKey: true });
    b.key({ key: 'Home', code: 'Home' });
    const before = b.view();
    parked.push(lastTs + MINUTE_MS, 101);
    // Looking at the open, a bar closing must not jump the view to it.
    expect(b.view()).toEqual(before);
    b.unmount();
  });
});

/* ============================================================================================= */
/* 8. Staleness on the legend (TERM-12, CLIENT.md §12.1)                                          */
/* ============================================================================================= */

describe('the chart legend applies the ValueState mapping (§12.1, TERM-12)', () => {
  /** The legend value cell of one series, and its `data-st` — the attribute `tokens.css` styles. */
  function legendCell(h: Harness, seriesId: string): HTMLElement {
    const cell = h.host.querySelector<HTMLElement>(`.chart__legend-value[data-value-of="${seriesId}"]`);
    if (cell === null) throw new Error(`no legend value cell for ${seriesId}`);
    return cell;
  }

  it('writes data-st from the frame, and ages it to stale when the sweep says so', () => {
    const spec = gipStreamingSpec();
    const binding = spec.series[0]?.live;
    const xs = spec.series[0]?.x;
    if (binding === undefined || xs === undefined) throw new Error('the GIP spec changed shape');
    const lastTs = Number(xs[310]);
    const live = liveHarness(binding.subject, lastTs, 100);
    const h = mount(spec, live.source);
    h.key({ key: 'End', code: 'End' });
    const cell = legendCell(h, 'p');

    // Before any frame there is no verdict to state, and none is invented: `ChartSeries` carries no
    // `st` and the payload's `meta.staleness` does not reach a widget, so claiming `live` for a payload
    // number is the one answer that would repeat WP-13's blocker.
    expect(cell.getAttribute('data-st')).toBeNull();

    live.push(lastTs, 333.3);
    expect(cell.textContent).toBe('333.30');
    expect(cell.getAttribute('data-st')).toBe('live');

    // An hour after the capture the real `core/quote/staleness.ts#valueState` rules this subject stale,
    // and the same frame re-delivered must not leave a "live" number on the screen (§12.1 rule 1).
    live.sweepAge();
    live.redeliver();
    expect(cell.getAttribute('data-st')).toBe('stale');
    expect(cell.textContent).toBe('333.30');
    h.unmount();
  });

  it('restyles on the 1 s sweep alone, with no frame and no React commit', () => {
    const spec = gipStreamingSpec();
    const binding = spec.series[0]?.live;
    const xs = spec.series[0]?.x;
    if (binding === undefined || xs === undefined) throw new Error('the GIP spec changed shape');
    const lastTs = Number(xs[310]);
    const live = liveHarness(binding.subject, lastTs, 100);
    const h = mount(spec, live.source);
    h.key({ key: 'End', code: 'End' });
    live.push(lastTs, 333.3);
    const cell = legendCell(h, 'p');
    expect(cell.getAttribute('data-st')).toBe('live');
    const commitsBefore = h.commits();

    // The chart subscribed the sweep (a source that does not offer one ages nothing, which is honest —
    // but this one does, as `rt/wsBridge.ts` does for the grid).
    expect(live.sweepCount()).toBe(1);
    live.age(CAPTURED_AT + 3_600_000);

    expect(cell.getAttribute('data-st')).toBe('stale');
    // A number going stale is not a number changing: the value is untouched, and nothing re-rendered.
    expect(cell.textContent).toBe('333.30');
    expect(h.commits()).toBe(commitsBefore);
    h.unmount();
  });
});

/* ============================================================================================= */
/* 9. The DOM furniture is reachable, not painted under an opaque canvas (§11.1, §11.8)            */
/* ============================================================================================= */

describe('the picker and the footer are above the canvases (§11.1, §11.8)', () => {
  it('positions the study picker over the canvas, not under it', () => {
    const h = mount(gipSpec());
    h.key({ key: 's', code: 'KeyS' });
    const picker = h.host.querySelector<HTMLElement>('.chart__picker');
    const canvas = h.host.querySelector<HTMLElement>('canvas.chart__base');
    if (picker === null || canvas === null) throw new Error('no picker or no canvas');

    // Both canvases are `position:absolute; inset:0` inside a `position:relative` host and the base is
    // OPAQUE (`alpha: false`, repainted every frame). CSS 2.1 painting order puts positioned
    // descendants above non-positioned ones, so a static picker is painted underneath — which is what
    // shipped: `S` opened a search field with `autoFocus` that the user could not see while typing.
    // jsdom does not lay out, so this reads the two properties that decide the stacking, which is why
    // it is asserted here rather than left to a browser.
    const style = getComputedStyle(picker);
    expect(style.position).toBe('absolute');
    expect(Number(style.zIndex)).toBeGreaterThan(0);
    expect(getComputedStyle(canvas).zIndex === '' || Number(getComputedStyle(canvas).zIndex) === 0).toBe(
      true,
    );
    // And it is focusable and focused, which is the reason it has to be visible at all.
    expect(document.activeElement).toBe(picker.querySelector('input'));
    h.unmount();
  });

  it('positions the draw-mode footer over the canvas (§11.8’s kind letters)', () => {
    const h = mount(gipSpec());
    h.key({ key: 'd', code: 'KeyD' });
    const footer = h.host.querySelector<HTMLElement>('.chart__footer');
    if (footer === null) throw new Error('draw mode drew no footer');
    expect(footer.textContent).toContain('TREND');
    const style = getComputedStyle(footer);
    expect(style.position).toBe('absolute');
    expect(Number(style.zIndex)).toBeGreaterThan(0);
    h.unmount();
  });

  it('hides the readout, the legend and the studies list DELIBERATELY, and keeps them readable', () => {
    const h = mount(gipSpec());
    // The renderer draws the visible legend and readout on the base canvas (§11.1 lists the legend
    // among its contents), so their DOM copies are for the keyboard and the screen reader. Hidden by
    // clipping and NOT by `display:none`, which would take them out of the accessibility tree — and the
    // host cites the readout through `aria-describedby`, so that would break the description too.
    for (const selector of ['.chart__readout', '.chart__legend']) {
      const el = h.host.querySelector<HTMLElement>(selector);
      if (el === null) throw new Error(`no ${selector}`);
      const style = getComputedStyle(el);
      expect(style.display, selector).not.toBe('none');
      expect(style.visibility, selector).not.toBe('hidden');
      expect(style.position, selector).toBe('absolute');
      // Clipped to nothing: a one-pixel box with its overflow hidden and `clip-path: inset(50%)`.
      // (`clip` is set too, for browsers that predate `clip-path`; jsdom's CSSOM drops the deprecated
      // property entirely, so it is the modern half that is asserted here.)
      expect(el.style.clipPath, selector).toBe('inset(50%)');
      expect(style.overflow, selector).toBe('hidden');
      expect(style.width, selector).toBe('1px');
      expect(style.height, selector).toBe('1px');
    }
    expect(h.host.getAttribute('aria-describedby')).toBe('chart1-readout');
    expect(h.readout.id).toBe('chart1-readout');
    h.unmount();
  });
});

/* ============================================================================================= */
/* 10. `T` cycles types this chart can draw AND this function can persist (§11.3, §11.9)           */
/* ============================================================================================= */

describe('the type cycle stays inside the screen’s own enum (§11.3, §11.9)', () => {
  it('reports only types GP’s manifest accepts, and never scatter', () => {
    const h = mount(gpSpec());
    const seen: string[] = [];
    // Round the whole cycle and one more, so the wrap is covered too.
    for (let i = 0; i < cyclableTypes(gpSpec()).length + 1; i += 1) {
      h.key({ key: 't', code: 'KeyT' });
      const type = h.host.dataset.type ?? '';
      seen.push(type);
      const patch = h.params.at(-1);
      expect(patch, `press ${String(i + 1)} reported nothing`).toEqual({ type });
      // THE ASSERTION THAT WAS MISSING: every reported patch has to survive the screen's own params
      // schema, because `ScreenCtx.setParams` puts it in the next run request. `T` walked all twelve
      // `SERIES_TYPES` and `scatter` is not in `GpChartType`, so one press in twelve sent a value the
      // next request could not validate.
      const parsed = manifests.GP.params.safeParse({ type });
      expect(parsed.success, `GP.params rejected { type: '${type}' }`).toBe(true);
    }
    expect(seen).not.toContain('scatter');
    // A daily equity chart cannot draw a 30-minute TPO profile (§11.3 ships `profile` for intraday
    // 1-/5-day ranges) and `heatmap`'s colour is a volume under a price axis, so neither is offered.
    expect(seen).not.toContain('profile');
    expect(seen).not.toContain('heatmap');
    // And the cycle returned to where it started rather than stopping somewhere.
    expect(new Set(seen).size).toBe(cyclableTypes(gpSpec()).length);
    h.unmount();
  });

  it('offers GIP its bar types and the profile view, because GIP is intraday with a bar', () => {
    const spec = gipSpec();
    const cycle = cyclableTypes(spec);
    expect(cycle).toContain('candle');
    expect(cycle).toContain('ohlc');
    expect(cycle).toContain('profile');
    expect(cycle).not.toContain('scatter');
    expect(cycle).not.toContain('heatmap');

    const h = mount(spec);
    expect(h.host.dataset.type).toBe('candle');
    h.key({ key: 't', code: 'KeyT' });
    expect(h.host.dataset.type).toBe('ohlc');
    h.unmount();
  });

  it('declines T on a chart whose authored mark is the only one its data supports', () => {
    // OMON's smile is `scatter` because the data is points: a strike band with no bars, no volume and
    // no time axis. Cycling it would draw a candle series with no candles and report a type OMON has no
    // parameter for, so `T` does nothing and says nothing.
    const smile: ChartSpec = {
      kind: 'curve',
      xAxis: { type: 'tenor' },
      yAxes: [{ id: 'y', side: 'right', scale: 'linear', fmt: 'pct', decimals: 2 }],
      panes: [{ id: 'main', height: 1 }],
      series: [
        {
          id: 'iv',
          label: 'Implied vol',
          type: 'scatter',
          pane: 'main',
          yAxis: 'y',
          x: [340, 350, 360],
          y: [0.21, 0.2, 0.22],
          provIdx: 0,
        },
      ],
      crosshair: true,
    };
    const h = mount(smile);
    expect(h.host.dataset.type).toBe('scatter');
    h.key({ key: 't', code: 'KeyT' });
    expect(h.host.dataset.type).toBe('scatter');
    expect(h.params).toEqual([]);
    h.unmount();
  });

  it('toggles the profile view on P and VWAP on V (§11.9’s last row)', () => {
    const h = mount(gipSpec());
    expect(h.host.dataset.type).toBe('candle');
    h.key({ key: 'p', code: 'KeyP' });
    expect(h.host.dataset.type).toBe('profile');
    expect(h.params.at(-1)).toEqual({ type: 'profile' });
    h.key({ key: 'p', code: 'KeyP' });
    expect(h.host.dataset.type).toBe('candle');

    h.key({ key: 'v', code: 'KeyV' });
    expect([...h.host.querySelectorAll('[data-study-id]')].map((li) => li.getAttribute('data-study-id'))).toEqual(
      ['VWAP'],
    );
    expect(h.params.at(-1)?.studies).toEqual([{ id: 'VWAP', params: { anchor: 0 }, pane: 'main' }]);
    // VWAP is a `main` overlay (§11.6), so the patch says `main` — and GP's params accept it.
    expect(manifests.GP.params.safeParse({ studies: h.params.at(-1)?.studies }).success).toBe(true);
    h.key({ key: 'v', code: 'KeyV' });
    expect(h.host.querySelectorAll('[data-study-id]')).toHaveLength(0);
    h.unmount();
  });

  it('declines V and P on a chart whose series cannot supply them', () => {
    // A close-only daily series: no volume for VWAP (`needs: ['volume']`, and it throws without one),
    // no bar and no intraday range for a market profile.
    const line: ChartSpec = {
      kind: 'price',
      xAxis: { type: 'time' },
      yAxes: [{ id: 'y', side: 'right', scale: 'linear', fmt: 'px', decimals: 3 }],
      panes: [{ id: 'main', height: 1 }],
      series: [
        {
          id: 'p',
          label: 'T 10Y Govt',
          type: 'line',
          pane: 'main',
          yAxis: 'y',
          x: [1, 2, 3, 4],
          y: [3.9, 3.95, 4.01, 4.0],
          provIdx: 0,
        },
      ],
      crosshair: true,
    };
    const h = mount(line);
    h.key({ key: 'v', code: 'KeyV' });
    h.key({ key: 'p', code: 'KeyP' });
    expect(h.host.querySelectorAll('[data-study-id]')).toHaveLength(0);
    expect(h.host.dataset.type).toBe('line');
    expect(h.params).toEqual([]);
    h.unmount();
  });

  it('says so in the DOM when a persisted study cannot be computed on this series (§11.6)', () => {
    // The path that used to kill the screen: `layout.chart.studies` is a DEFAULT, so a study added on
    // an equity chart arrives in the spec of the next govt or rate chart. `setSpec` threw a `RangeError`
    // out of the effect; now the pane is empty and the list says which column is missing, which is a
    // visibly missing study rather than no chart at all.
    const govt: ChartSpec = {
      kind: 'price',
      xAxis: { type: 'time' },
      yAxes: [{ id: 'y', side: 'right', scale: 'linear', fmt: 'pct', decimals: 3 }],
      panes: [
        { id: 'main', height: 0.75 },
        { id: 'ATR', height: 0.25, title: 'ATR' },
      ],
      series: [
        {
          id: 'p',
          label: 'T 10Y Govt',
          type: 'line',
          pane: 'main',
          yAxis: 'y',
          x: [1, 2, 3, 4, 5],
          y: [3.9, 3.95, 4.01, 4.0, 3.98],
          provIdx: 0,
        },
      ],
      studies: [{ id: 'ATR', params: { n: 14 }, pane: 'ATR', inputSeriesId: 'p' }],
      crosshair: true,
    };
    const h = mount(govt);
    h.key({ key: 'End', code: 'End' });
    const cell = h.host.querySelector<HTMLElement>('[data-value-of-study="ATR"]');
    expect(cell?.textContent).toBe('not available — needs ohlc');
    h.unmount();
  });

  it('offers only the studies this series can feed in the picker (§11.6)', () => {
    // The picker used to offer all twenty-two whatever the series carried, and `Enter` on one of the
    // twelve that need a bar threw out of `Renderer.setSpec` — one keystroke from a working chart to a
    // dead screen on any yield, rate or index series.
    const rates: ChartSpec = {
      kind: 'price',
      xAxis: { type: 'time' },
      yAxes: [{ id: 'y', side: 'right', scale: 'linear', fmt: 'pct', decimals: 3 }],
      panes: [{ id: 'main', height: 1 }],
      series: [
        {
          id: 'p',
          label: 'EFFR',
          type: 'step',
          pane: 'main',
          yAxis: 'y',
          x: [1, 2, 3, 4, 5],
          y: [3.63, 3.63, 3.63, 3.63, 3.63],
          provIdx: 0,
        },
      ],
      crosshair: true,
    };
    const h = mount(rates);
    h.key({ key: 's', code: 'KeyS' });
    const offered = [...h.host.querySelectorAll('[data-study-option]')].map(
      (b) => (b as HTMLElement).dataset.studyOption ?? '',
    );
    expect(offered).toHaveLength(10);
    for (const id of ['ATR', 'VOL', 'OBV', 'STOCH', 'PSAR', 'VWAP', 'ADX', 'CCI', 'WILLR', 'ICHIMOKU', 'DONCHIAN', 'KELTNER']) {
      expect(offered, `${id} needs a column this series has not got`).not.toContain(id);
    }
    for (const id of ['SMA', 'EMA', 'RSI', 'MACD', 'HVOL']) {
      expect(offered, `${id} needs only the close`).toContain(id);
    }
    h.unmount();
  });
});
