/**
 * packages/web/test/screen/sparkline.test.tsx — the `custom#Sparkline` component (CHRT-01, DATA-10,
 * TERM-06).
 *
 * The node is DES's (`rate` variant), ECO's and EE's, and until this component existed all three drew
 * `data-pending="Sparkline"`. What has to be true of it is not "a canvas exists": it is that the ink
 * is the engine's, that a `v: null` is a HOLE and not a line drawn through it, and that nothing on
 * the canvas is a number — because the points carry no provenance and DATA-10 does not allow a drawn
 * number whose source cannot be named.
 *
 * **The props come from the three shipped screens**, built by handing each `Screen.tsx` its committed
 * golden payload, so nothing below asserts against a shape invented for this file. That matters twice
 * over here: DES passes `t` as an ISO DATE STRING and a `label`, while ECO and EE pass epoch
 * milliseconds and a `fmt` — a component tested only against one of those would ship broken for the
 * other two screens.
 *
 * jsdom does not lay out, so `getBoundingClientRect` is stubbed to one box and the pixels below are
 * measured against that box (TESTING §2.2). The 2-D context is the real `canvas` package's, the same
 * one `test/chart/renderer.test.ts` takes its pixel goldens on; without it there are no pixels at
 * all, and the test says so rather than passing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifests } from '@terminal/core';
import type { FunctionCode, ParamsOf, PayloadOf } from '@terminal/core';
import type { PayloadMeta } from '@terminal/sdk';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenRenderer } from '../../src/screen/ScreenRenderer.js';
import type { Node, ScreenCtx, ScreenSpec } from '../../src/screen/types.js';
import { Sparkline, drawSparkline, sparklineDataOf, sparklineName } from '../../src/screen/widgets/Sparkline.js';
import type { SparklineData } from '../../src/screen/widgets/Sparkline.js';
import type { CustomComponentProps, WidgetRegistry } from '../../src/screen/widgets/registry.js';
import { screenModules } from '../../src/screens/index.js';
import { buildWidgetRegistry } from '../../src/widgets.js';

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(TEST_DIR))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

const WIDTH = 240;
const HEIGHT = 48;
const BOX = {
  x: 0,
  y: 0,
  width: WIDTH,
  height: HEIGHT,
  top: 0,
  left: 0,
  right: WIDTH,
  bottom: HEIGHT,
  toJSON: () => ({}),
} as DOMRect;

function golden<C extends FunctionCode>(file: string): PayloadOf<C> {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as PayloadOf<C>;
}

const META: PayloadMeta = {
  traceId: '11111111-2222-4333-8444-555555555555',
  resultId: '01J0000000000000000000SPRK',
  asOf: { validAt: '2026-09-15T18:41:28.000Z', knownAt: '2026-09-15T18:41:28.000Z' },
  tier: 'delayed',
  staleness: 'live',
  provenance: Array.from({ length: 8 }, (_v, idx) => ({
    idx,
    sourceId: `source.${String(idx)}`,
    provenanceId: 900 + idx,
    capturedAt: '2026-09-15T18:41:28.000Z',
    sourceTs: '2026-09-15T18:26:26.000Z',
    attribution: `Attribution ${String(idx)}`,
    requestKey: `key:${String(idx)}`,
    responseSha256: 'f'.repeat(64),
    adapterVersion: '1',
  })),
  unavailable: [],
  entitlement: [],
  engines: [],
  servedAt: '2026-09-15T18:41:28.100Z',
};

function ctxFor(code: FunctionCode, params: unknown): ScreenCtx<never> {
  return {
    panelId: 'p1',
    code,
    params: params as never,
    setParams: () => undefined,
    navigate: () => undefined,
    navigateNext: () => undefined,
    openUrl: () => undefined,
    provenance: () => undefined,
    export: () => undefined,
    page: () => undefined,
  } as unknown as ScreenCtx<never>;
}

/** The `ScreenSpec` a shipped screen returns for its own golden payload. */
function specOf(code: 'DES' | 'ECO' | 'EE', file: string, params: Record<string, unknown>): ScreenSpec {
  const module = screenModules[code];
  const manifest = manifests[code];
  const parsed = manifest.params.parse(params) as ParamsOf<typeof code>;
  return module.Screen({
    payload: golden(file),
    params: parsed,
    meta: META,
    ctx: ctxFor(code, parsed),
  } as never);
}

/** Every `custom#Sparkline` node in a spec, whatever it is nested inside. */
function sparklineNodes(spec: ScreenSpec): Extract<Node, { kind: 'custom' }>[] {
  const found: Extract<Node, { kind: 'custom' }>[] = [];
  const walk = (node: Node): void => {
    if (node.kind === 'custom' && node.component === 'Sparkline') found.push(node);
    if (node.kind === 'split') node.children.forEach(walk);
    if (node.kind === 'tabs') node.tabs.forEach((tab) => walk(tab.body));
  };
  walk(spec.body);
  return found;
}

function mountCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error(
      'no 2-D context: the `canvas` package did not build, and the ink assertions in this file ' +
        'need one (the same requirement as test/chart/renderer.test.ts).',
    );
  }
  return ctx;
}

/** Pixels with any alpha — the canvas is cleared, not filled, so ink is anything opaque. */
function inkedPixels(canvas: HTMLCanvasElement): number {
  const data = context(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 8) n += 1;
  return n;
}

/** The x of every column that has ink, so a gap in the line is observable as a gap in x. */
function inkedColumns(canvas: HTMLCanvasElement): number[] {
  const { width, height } = canvas;
  const data = context(canvas).getImageData(0, 0, width, height).data;
  const columns: number[] = [];
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 8) {
        columns.push(x);
        break;
      }
    }
  }
  return columns;
}

const DATA = (values: (number | null)[]): SparklineData => {
  const data = sparklineDataOf({ points: values.map((v, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, v })) });
  if (data === null) throw new Error('these props are a point series');
  return data;
};

const OPTS = { width: WIDTH, height: HEIGHT, dpr: 1, colour: '#4da3ff' };

function fonts(): Parameters<typeof drawSparkline>[2]['fonts'] {
  return { axis: '400 12px monospace', label: '500 12px monospace', readout: '500 12px monospace', lineHeightPx: 18, digitPx: 7.2 };
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(BOX);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/* ---------------------------------------------------------------------------------------------- */
/* The props the three screens really pass                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe('the props DES, ECO and EE pass to `custom#Sparkline`', () => {
  it('DES `rate` hands over an ISO-date series, and it is read', () => {
    // SOFR is the seeded rate DES's `rate` variant is written against; its golden is the payload the
    // resolver produces at the frozen clock.
    const spec = specOf('DES', 'DES.rate.json', { security: 'SOFR Index' });
    const nodes = sparklineNodes(spec);
    expect(nodes.map((n) => n.id)).toEqual(['sparkline']);

    const data = sparklineDataOf(nodes[0]?.props);
    expect(data).not.toBeNull();
    // Every row of the payload's own history, and the label the screen passes — not a sample of them.
    // `DES.rate.json` carries four sessions of SOFR (§DES asks for 30; the seeded curve has four),
    // which is why the count is pinned exactly: a component that read one point, or that read the
    // array length and drew nothing, both pass a `> 0`.
    const history = golden<'DES'>('DES.rate.json') as { history: { effectiveDate: string; rate: number | null; provIdx: number }[] };
    expect(data?.points.length).toBe(history.history.length);
    expect(data?.points.map((p) => p.v)).toEqual(history.history.map((h) => h.rate));
    expect(data?.label).toBe('SOFR Index');

    // WHY this node cites no provenance, pinned where it can be read. The payload has a `provIdx`
    // per history row — 2, the SOFR capture — and `DES/Screen.tsx` maps the rows down to `{ t, v }`
    // and drops it, so nothing attributable reaches the component. The day the call site passes it,
    // this assertion fails and the component's "prints no number" contract is reconsidered on
    // purpose, instead of a traceability row going quietly stale (BUILD_STATUS, DATA-10).
    expect(history.history.every((h) => Number.isInteger(h.provIdx) && h.provIdx >= 0)).toBe(true);
    const asPassed = (nodes[0]?.props as { points: Record<string, unknown>[] }).points;
    expect(Object.keys(asPassed[0] ?? {})).toEqual(['t', 'v']);
    // The `t` values are `effectiveDate` strings; `sparklineDataOf` parses them, so they come back
    // as milliseconds in ascending order.
    const times = (data?.points ?? []).map((p) => p.t);
    expect(times.every((t) => Number.isFinite(t))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('ECO and EE hand over epoch-ms series, and they are read', () => {
    // `ECO.default.json` is the CALENDAR mode, which has no series and emits no sparkline; the
    // release-detail golden is the one whose body carries `custom#spark`.
    expect(sparklineNodes(specOf('ECO', 'ECO.default.json', {}))).toEqual([]);
    const eco = sparklineNodes(specOf('ECO', 'ECO.default-release.json', { releaseId: 5 }));
    expect(eco.length).toBe(1);
    const ecoData = sparklineDataOf(eco[0]?.props);
    expect(ecoData?.points.length).toBe(2);
    expect(ecoData?.points.every((p) => Number.isFinite(p.t) && Number.isFinite(p.v))).toBe(true);

    const ee = sparklineNodes(specOf('EE', 'EE.equity.json', { security: 'AAPL US Equity' }));
    expect(ee.length).toBe(1);
    const eeData = sparklineDataOf(ee[0]?.props);
    expect(eeData?.points.length).toBeGreaterThan(0);
    expect(eeData?.points.every((p) => Number.isFinite(p.t))).toBe(true);
  });

  it('is what the shipped registry serves that node with — no placeholder anywhere in it', () => {
    const registry: WidgetRegistry = buildWidgetRegistry();
    expect(registry.custom?.Sparkline).toBe(Sparkline);

    const spec = specOf('EE', 'EE.equity.json', { security: 'AAPL US Equity' });
    const { container } = render(<ScreenRenderer spec={spec} meta={META} widgets={registry} />);
    expect(container.querySelectorAll('[data-pending]')).toHaveLength(0);
    const spark = container.querySelector<HTMLElement>('.spark');
    expect(spark).not.toBeNull();
    expect(spark?.dataset.sparkState).toBe('drawn');
    expect(Number(spark?.dataset.sparkPoints)).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The ink                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe('what is drawn', () => {
  it('draws a line across the box, and a different series draws differently', () => {
    const rising = mountCanvas();
    const drawn = drawSparkline(rising, DATA([1, 2, 3, 4, 5, 6, 7, 8]), { ...OPTS, fonts: fonts() });
    expect(drawn).toBe(8);
    const risingInk = inkedPixels(rising);
    // A blank canvas is the failure this build has shipped before (BUILD_STATUS: "a pixel golden of
    // a blank canvas"), so the floor is a real one: a 240 px box crossed by a 1.5 px stroke cannot
    // be under 200 px of ink.
    expect(risingInk).toBeGreaterThan(200);
    // Both ends are inked: the polyline reaches the edges of its own box rather than sitting in the
    // middle of it.
    const columns = inkedColumns(rising);
    expect(columns[0]).toBeLessThan(4);
    expect(columns[columns.length - 1]).toBeGreaterThan(WIDTH - 5);

    // The same box and the same count, a different shape — which is what proves the ink follows the
    // data and not the geometry.
    const zigzag = mountCanvas();
    drawSparkline(zigzag, DATA([1, 8, 1, 8, 1, 8, 1, 8]), { ...OPTS, fonts: fonts() });
    const a = context(rising).getImageData(0, 0, rising.width, rising.height).data;
    const b = context(zigzag).getImageData(0, 0, zigzag.width, zigzag.height).data;
    let differing = 0;
    for (let i = 3; i < a.length; i += 4) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 8) differing += 1;
    expect(differing).toBeGreaterThan(100);
  });

  it('breaks the line at a null point instead of drawing through it (§11.2)', () => {
    // The engine's own rule, inherited rather than re-implemented: `series.ts#buildPath` treats a
    // non-finite y as the end of the current path. A sparkline that interpolated across the hole
    // would be inventing a rate that was never published — which is the whole reason `v` is
    // nullable in ECO's `chart` and EE's `sparkline`.
    const whole = mountCanvas();
    drawSparkline(whole, DATA([1, 2, 3, 4, 5, 6, 7, 8]), { ...OPTS, fonts: fonts() });
    const gapped = mountCanvas();
    const drawn = drawSparkline(gapped, DATA([1, 2, 3, null, null, 6, 7, 8]), { ...OPTS, fonts: fonts() });
    expect(drawn).toBe(6);

    const wholeColumns = new Set(inkedColumns(whole));
    const gappedColumns = new Set(inkedColumns(gapped));
    expect(gappedColumns.size).toBeLessThan(wholeColumns.size);
    // The hole is where the two null slots are: slots 3 and 4 of 8 over 240 px is x ≈ 105..150.
    const inHole = [...gappedColumns].filter((x) => x > 108 && x < 145);
    expect(inHole, 'the line was drawn straight through a gap').toEqual([]);
  });

  it('draws a flat series and a single point rather than dividing by a zero span', () => {
    const flat = mountCanvas();
    expect(drawSparkline(flat, DATA([4.33, 4.33, 4.33, 4.33]), { ...OPTS, fonts: fonts() })).toBe(4);
    expect(inkedPixels(flat)).toBeGreaterThan(100);

    // One visible point is stamped by the engine (`buildPath`'s last clause): a new listing's first
    // print, or ECO's first observation of a release, must be visible and not dropped.
    const single = mountCanvas();
    expect(drawSparkline(single, DATA([7.5]), { ...OPTS, fonts: fonts() })).toBe(1);
    expect(inkedPixels(single)).toBeGreaterThan(0);
  });

  it('draws nothing at all when there is nothing to draw', () => {
    const empty = mountCanvas();
    expect(drawSparkline(empty, DATA([]), { ...OPTS, fonts: fonts() })).toBe(0);
    expect(inkedPixels(empty)).toBe(0);

    const allNull = mountCanvas();
    expect(drawSparkline(allNull, DATA([null, null, null]), { ...OPTS, fonts: fonts() })).toBe(0);
    expect(inkedPixels(allNull), 'a series of nulls put ink on the canvas').toBe(0);

    // A zero-sized box is the state every host is in before it is laid out; it must not throw.
    const unsized = mountCanvas();
    expect(drawSparkline(unsized, DATA([1, 2, 3]), { ...OPTS, width: 0, height: 0, fonts: fonts() })).toBe(0);
  });

  it('sizes its backing store by the device pixel ratio (TERM-10)', () => {
    const retina = mountCanvas();
    drawSparkline(retina, DATA([1, 2, 3, 4]), { ...OPTS, dpr: 2, fonts: fonts() });
    expect(retina.width).toBe(WIDTH * 2);
    expect(retina.height).toBe(HEIGHT * 2);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* What it says, and what it refuses to say (DATA-10, TERM-06)                                      */
/* ---------------------------------------------------------------------------------------------- */

describe('the sparkline node in the DOM', () => {
  const nodeProps = (props: unknown): CustomComponentProps => ({
    id: 'spark',
    component: 'Sparkline',
    props,
    actions: { navigate: () => undefined, navigateNext: () => undefined, openUrl: () => undefined, provenance: () => undefined },
  });

  it('prints no number and cites no provenance, and says so', () => {
    // The rule this component is built around: the points carry no `provIdx`, so nothing here may be
    // a number a trader could read a level off. No `data-prov-idx` either — `ScreenRenderer` answers
    // `Ctrl+I` with `provIdxOfFocus() ?? -2`, so the absence IS the honest answer, and it keeps a
    // phantom field out of `collectScreenState`'s harvest.
    const { container } = render(<Sparkline {...nodeProps({ points: [{ t: 1, v: 4.33 }, { t: 2, v: 4.41 }], fmt: 'px' })} />);
    const host = container.querySelector<HTMLElement>('.spark');
    expect(host).not.toBeNull();
    expect(host?.hasAttribute('data-prov-idx')).toBe(false);
    expect(host?.dataset.sparkCites).toBe('none');
    // No digit of the data anywhere in the text, including the accessible name.
    expect(container.textContent ?? '').not.toContain('4.33');
    expect(host?.getAttribute('aria-label') ?? '').not.toContain('4.33');
    expect(host?.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is a tab stop with a name that carries what the picture carries (TERM-06)', () => {
    const { container } = render(
      <Sparkline {...nodeProps({ points: [{ t: 1, v: 1 }, { t: 2, v: null }, { t: 3, v: 9 }] })} />,
    );
    const host = container.querySelector<HTMLElement>('.spark');
    expect(host?.tabIndex).toBe(0);
    const name = host?.getAttribute('aria-label') ?? '';
    expect(name).toContain('3 points');
    expect(name).toContain('1 with no value');
    expect(name).toContain('rising');
    expect(name).toContain('cites no source');
  });

  it('says a release with no series has no history, rather than drawing an empty box', () => {
    // ECO's real state for a release whose `series[0]` is absent: `props.points` is `[]`.
    const { container } = render(<Sparkline {...nodeProps({ points: [], fmt: 'px' })} />);
    expect(container.querySelector<HTMLElement>('.spark')?.dataset.sparkState).toBe('empty');
    expect(container.textContent).toContain('No history for this series');
  });

  it('names the node when the props are not a series at all', () => {
    const { container } = render(<Sparkline {...nodeProps({ spec: null })} />);
    const host = container.querySelector<HTMLElement>('.spark--unreadable');
    expect(host).not.toBeNull();
    expect(host?.textContent).toContain('spark');
    expect(host?.tabIndex).toBe(0);
  });

  it('reports the trend and the gaps from the data, not from its own state', () => {
    expect(sparklineName('x', DATA([3, 2, 1]))).toContain('falling');
    expect(sparklineName('x', DATA([1, 1]))).toContain('flat');
    expect(sparklineName('x', DATA([]))).toBe('Sparkline x — no points to plot');
  });
});
