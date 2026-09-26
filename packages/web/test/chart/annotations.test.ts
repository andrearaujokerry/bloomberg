// packages/web/test/chart/annotations.test.ts — WP-14's named acceptance row for CHRT-05: "anchors
// survive a zoom/pan round-trip and serialise to the `chart_annotations.anchors` shape"
// (CLIENT.md §11.8).
//
// ## The round trip is the test that matters
//
// An annotation held in pixel space looks perfect until the first zoom, and then it is attached to
// two dates that are not the ones it was drawn between, with nothing on screen to say so. So the
// round trip below does not merely project and invert: it projects under one viewport, zooms, pans,
// zooms back, and asserts that the anchor comes back to the same `{ t, v }` WITH THE SLOT MAPPING
// AND THE Y RANGE HAVING CHANGED UNDERNEATH IT. Both mappings move (the test's scales autoscale the
// y-axis to the visible window, as a real axis does), and the test asserts that they moved —
// otherwise the round trip would be trivially satisfied by a no-op and would measure nothing.
//
// ## Why the event band is in this file
//
// `events.ts` has no acceptance row of its own in the WORKPLAN table and WP-14's file list does not
// give it a test file, so its geometry, hit testing and focus order are asserted here rather than
// left unasserted: both modules are spec-driven overlays projected through the same slot index, and
// a marker whose `command` the keyboard cannot reach is a CHRT-06 failure however few rows the plan
// spends on it.
//
// ## The data
//
// `fixtures/providers/normalised/yahoo-chart-events.json` — 1255 real daily bars and 20 REAL
// dividends, on disk, no network (FEED-08, QA-02). The dividends are what the event band is driven
// with; §11.6 nominates `yahoo-chart-AAPL-max-1d.json` for study goldens, and that capture is
// QUARTERLY (TESTING.md L748), so it is not used here either.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { olsRegression } from '@terminal/core/analytics/stats/index';
import { ChartAnnotationInput } from '@terminal/sdk/wire/rest/workspaces';
import type { ChartAnnotation as ChartAnnotationRecord } from '@terminal/sdk/wire/rest/workspaces';
import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_HIT_PX,
  FIB_RATIOS,
  REGRESSION_SIGMAS,
  anchorAt,
  anchorPoint,
  annotationFromRecord,
  fibLevels,
  hitTestAnnotations,
  projectAnnotation,
  regressionFit,
  serialiseAnnotation,
} from '../../src/chart/annotations.js';
import type {
  AnnotationAnchor,
  AnnotationContext,
  AnnotationScales,
  AnnotationSlots,
  ChartAnnotation,
} from '../../src/chart/annotations.js';
import {
  EVENT_GLYPH,
  EVENT_KINDS,
  MARKER_MIN_HIT_PX,
  hitTestEventMarkers,
  layoutEventMarkers,
  markerOfEvent,
  nextEventMarker,
} from '../../src/chart/events.js';
import type { ChartEvent } from '../../src/chart/events.js';
import type { ChartFonts, Rect, Viewport } from '../../src/chart/types.js';

/** `packages/web/test/chart/` → `packages/web/` → the monorepo root. */
const WEB_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(WEB_ROOT));

const CLIENT_MD = readFileSync(join(REPO_ROOT, 'docs', 'CLIENT.md'), 'utf8');
const MIGRATION_0012 = readFileSync(
  join(REPO_ROOT, 'packages', 'server', 'drizzle', 'migrations', '0012_workspace_portfolio.sql'),
  'utf8',
);

interface Fixture {
  granularity: string;
  bars: { barTs: number; close: number; high: number; low: number }[];
  dividends: { exTsMs: number; exDate: string; amount: number; currency: string }[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    join(REPO_ROOT, 'fixtures', 'providers', 'normalised', 'yahoo-chart-events.json'),
    'utf8',
  ),
) as Fixture;

const X = Float64Array.from(FIXTURE.bars, (b) => b.barTs);
const CLOSES = Float64Array.from(FIXTURE.bars, (b) => b.close);

/* -------------------------------------------------------------------------------------------- */
/* The two ports, implemented over the fixture                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * A `TradingDayIndex` over the fixture's timestamps (§11.2): sorted, one slot per bar, gaps
 * compressed.
 *
 * The test's own implementation of the two ports rather than `chart/tradingDayIndex.ts` itself: that
 * class is a sibling's file, and a test of the annotation layer that failed when its index changed
 * would be testing the wrong thing. It is deliberately the SIMPLEST index that satisfies the
 * contracts — binary search, linear interpolation between neighbours — so the round-trip assertions
 * below are about the annotation and not about a clever index.
 *
 * The two ports are wired as the renderer must wire them, and they are NOT the same function:
 * `AnnotationSlots.nearestSlot` is `TradingDayIndex.nearestSlot` (clamped into the axis, so an
 * anchor drawn on another periodicity still draws), and `EventBandInput.slotOf` is
 * `TradingDayIndex.slotOf` (exact, `-1` off-axis, so an event with no session on this axis is
 * dropped rather than drawn on the first bar). All 20 of the fixture's dividend ex-dates are exact
 * bar timestamps, which is what makes the second wiring the right one.
 */
function tradingDayIndex(x: Float64Array): AnnotationSlots {
  const n = x.length;
  const at = (i: number): number => x[Math.max(0, Math.min(n - 1, i))] ?? Number.NaN;
  return {
    nearestSlot(t: number): number {
      if (t <= at(0)) {
        const step = at(1) - at(0);
        return step === 0 ? 0 : (t - at(0)) / step;
      }
      if (t >= at(n - 1)) {
        const step = at(n - 1) - at(n - 2);
        return step === 0 ? n - 1 : n - 1 + (t - at(n - 1)) / step;
      }
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (at(mid) <= t) lo = mid;
        else hi = mid;
      }
      const span = at(hi) - at(lo);
      return span === 0 ? lo : lo + (t - at(lo)) / span;
    },
    tsAt(slot: number): number {
      if (slot <= 0) return at(0) + slot * (at(1) - at(0));
      if (slot >= n - 1) return at(n - 1) + (slot - (n - 1)) * (at(n - 1) - at(n - 2));
      const lo = Math.floor(slot);
      return at(lo) + (slot - lo) * (at(lo + 1) - at(lo));
    },
  };
}

const SLOTS = tradingDayIndex(X);

/** `TradingDayIndex.slotOf`: the slot whose timestamp is exactly `t`, or -1. */
function exactSlotOf(t: number): number {
  const found = FIXTURE.bars.findIndex((bar) => bar.barTs === t);
  return found;
}

const PLOT: Rect = { x: 60, y: 20, w: 800, h: 400 };

/**
 * The scales for one viewport — slot-linear in x, and AUTOSCALED in y to the visible closes.
 *
 * Autoscaling matters to the round trip: a y-axis fixed for the whole test would leave the value
 * half of an anchor trivially invertible, and a real price axis rescales on every pan (§11.2
 * `normalise` is recomputed on pan). Both halves of the mapping therefore differ between the
 * viewports below, which is what makes the surviving anchor evidence of anything.
 *
 * `x`/`slotAt` and `y`/`valueAt` are exact algebraic inverses, as the renderer's are.
 */
function scalesFor(view: Viewport, plot: Rect = PLOT): AnnotationScales {
  const slotSpan = view.slot1 - view.slot0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let slot = Math.max(0, Math.ceil(view.slot0)); slot <= Math.min(X.length - 1, Math.floor(view.slot1)); slot += 1) {
    const close = CLOSES[slot] ?? Number.NaN;
    if (!Number.isFinite(close)) continue;
    low = Math.min(low, close);
    high = Math.max(high, close);
  }
  const valueSpan = high - low;
  return {
    plot,
    x: (slot) => plot.x + ((slot - view.slot0) / slotSpan) * plot.w,
    slotAt: (px) => view.slot0 + ((px - plot.x) / plot.w) * slotSpan,
    y: (value) => plot.y + ((high - value) / valueSpan) * plot.h,
    valueAt: (py) => high - ((py - plot.y) / plot.h) * valueSpan,
  };
}

function contextFor(view: Viewport, options: { extendRight?: boolean } = {}): AnnotationContext {
  return {
    slots: SLOTS,
    scales: scalesFor(view),
    closes: CLOSES,
    extendRight: options.extendRight ?? false,
  };
}

/** An anchor on the bar at `slot`: its timestamp and its close. */
function anchorOfBar(slot: number): AnnotationAnchor {
  return { t: X[slot] ?? Number.NaN, v: CLOSES[slot] ?? Number.NaN };
}

function annotation(
  kind: ChartAnnotation['kind'],
  slots: number[],
  extra: { label?: string; annotationId?: number } = {},
): ChartAnnotation {
  return {
    annotationId: extra.annotationId ?? null,
    kind,
    anchors: slots.map(anchorOfBar),
    editable: true,
    ...(extra.label === undefined ? {} : { label: extra.label }),
  };
}

const FULL: Viewport = { slot0: 0, slot1: X.length - 1 };
const ZOOMED: Viewport = { slot0: 250.5, slot1: 960.25 };
const PANNED: Viewport = { slot0: 180.5, slot1: 890.25 };

/* -------------------------------------------------------------------------------------------- */

describe('the fixture (FEED-08, QA-02)', () => {
  it('is the 1255-bar daily capture with 20 real dividends', () => {
    expect(FIXTURE.granularity).toBe('1d');
    expect(FIXTURE.bars).toHaveLength(1255);
    expect(FIXTURE.dividends).toHaveLength(20);
  });
});

describe('CHRT-05: anchors survive a zoom/pan round trip (§11.8)', () => {
  const trendline = annotation('trendline', [300, 900]);

  it('projects to different pixels under a different viewport — both mappings move', () => {
    const wide = projectAnnotation(trendline, contextFor(FULL));
    const near = projectAnnotation(trendline, contextFor(ZOOMED));
    if (wide?.kind !== 'trendline' || near?.kind !== 'trendline') throw new Error('no geometry');
    // Stated as an assertion, not assumed: if the two viewports projected to the same pixels the
    // round trip below would hold for an implementation that stored pixels, and would prove nothing.
    expect(Math.abs(near.line[0].x - wide.line[0].x)).toBeGreaterThan(1);
    expect(Math.abs(near.line[0].y - wide.line[0].y)).toBeGreaterThan(1);
    expect(scalesFor(ZOOMED).y(anchorOfBar(300).v)).not.toBeCloseTo(
      scalesFor(FULL).y(anchorOfBar(300).v),
      1,
    );
  });

  it('recovers the same { t, v } from the pixels of a zoomed and panned viewport', () => {
    const before = structuredClone(trendline.anchors);

    for (const view of [FULL, ZOOMED, PANNED]) {
      const scales = scalesFor(view);
      for (const anchor of trendline.anchors) {
        const point = anchorPoint(anchor, SLOTS, scales);
        const recovered = anchorAt(point.x, point.y, SLOTS, scales);
        expect(recovered.t).toBe(anchor.t);
        expect(recovered.v).toBeCloseTo(anchor.v, 8);
      }
    }

    // The slot mapping really did change underneath: the pixels of the PANNED viewport read through
    // the FULL viewport's scales name a different bar and a different price. This is the assertion
    // that fails for an annotation stored in pixel space.
    const panned = scalesFor(PANNED);
    const first = trendline.anchors[0];
    if (first === undefined) throw new Error('no anchor');
    const point = anchorPoint(first, SLOTS, panned);
    const misread = anchorAt(point.x, point.y, SLOTS, scalesFor(FULL));
    expect(misread.t).not.toBe(first.t);
    expect(misread.v).not.toBeCloseTo(first.v, 2);

    // And nothing projected mutated the annotation.
    expect(trendline.anchors).toEqual(before);
  });

  it('returns to the identical pixels after zoom → pan → zoom back', () => {
    const start = projectAnnotation(trendline, contextFor(FULL));
    projectAnnotation(trendline, contextFor(ZOOMED));
    projectAnnotation(trendline, contextFor(PANNED));
    const back = projectAnnotation(trendline, contextFor(FULL));
    expect(back).toEqual(start);
  });

  it('holds for every kind that takes two anchors, not just the trendline', () => {
    for (const kind of ['trendline', 'fib', 'rect', 'regression_channel'] as const) {
      const shape = annotation(kind, [300, 900]);
      const start = projectAnnotation(shape, contextFor(FULL));
      expect(start, `${kind} projected nothing`).not.toBeNull();
      projectAnnotation(shape, contextFor(ZOOMED));
      expect(projectAnnotation(shape, contextFor(FULL))).toEqual(start);
    }
  });

  it('keeps an hline on its value and a vline on its instant when the viewport moves', () => {
    const hline = annotation('hline', [500]);
    const vline = annotation('vline', [500]);
    for (const view of [FULL, ZOOMED, PANNED]) {
      const h = projectAnnotation(hline, contextFor(view));
      const v = projectAnnotation(vline, contextFor(view));
      if (h?.kind !== 'hline' || v?.kind !== 'vline') throw new Error('no geometry');
      expect(h.v).toBe(anchorOfBar(500).v);
      expect(v.t).toBe(anchorOfBar(500).t);
      // An hline spans the plot and a vline spans its height, whatever the zoom.
      expect(h.line[0].x).toBe(PLOT.x);
      expect(h.line[1].x).toBe(PLOT.x + PLOT.w);
      expect(v.line[0].y).toBe(PLOT.y);
      expect(v.line[1].y).toBe(PLOT.y + PLOT.h);
    }
  });

  it('draws nothing for a kind with too few anchors', () => {
    const half: ChartAnnotation = { annotationId: null, kind: 'fib', anchors: [anchorOfBar(300)], editable: true };
    expect(projectAnnotation(half, contextFor(FULL))).toBeNull();
  });
});

describe('fib (§11.8)', () => {
  it('emits the seven levels CLIENT.md §11.8 names, in that order', () => {
    const documented = /`fib` \(2 anchors →\n?([\d./\s]+) levels\)/.exec(CLIENT_MD)?.[1];
    expect(documented, 'CLIENT.md §11.8 no longer states the fib levels').toBeDefined();
    expect([...FIB_RATIOS]).toEqual((documented ?? '').trim().split('/').map(Number));
  });

  it('puts 0 % at the first anchor and 100 % at the second, keeping the drawn direction', () => {
    // A fib drawn downward from a high to a low has its 0 % at the high; normalising the anchors
    // would silently rename every level a trader reads off it.
    const high = anchorOfBar(900);
    const low = anchorOfBar(300);
    const levels = fibLevels(high, low, scalesFor(FULL));
    expect(levels).toHaveLength(7);
    expect(levels[0]?.v).toBe(high.v);
    expect(levels[6]?.v).toBe(low.v);
    expect(levels[3]?.ratio).toBe(50);
    expect(levels[3]?.v).toBeCloseTo((high.v + low.v) / 2, 10);
    const span = low.v - high.v;
    expect(levels[4]?.v).toBeCloseTo(high.v + 0.618 * span, 10);
  });
});

describe('regression_channel (§11.8, API-05)', () => {
  const from = anchorOfBar(300);
  const to = anchorOfBar(900);

  it('is the OLS of core/analytics/stats, bit for bit, over the closes between the anchors', () => {
    // Exact equality with `olsRegression`'s own output, and that is the point: a reimplementation
    // here — even a correct one — would differ in the last bits of the slope and fail this. API-05
    // is that the screen and the API agree about the same window, and this is how it is enforced.
    const xs = Array.from({ length: 601 }, (_unused, i) => 300 + i);
    const ys = xs.map((slot) => CLOSES[slot] ?? Number.NaN);
    const expected = olsRegression(xs, ys);

    const fit = regressionFit(from, to, contextFor(FULL));
    if (fit === null) throw new Error('the channel did not fit');
    expect(fit.n).toBe(601);
    expect(fit.slope).toBe(expected.slope);
    expect(fit.intercept).toBe(expected.intercept);
    expect(fit.stdev).toBe(expected.residualStdErr);
    expect(fit.sigmas).toBe(REGRESSION_SIGMAS);
    expect(REGRESSION_SIGMAS).toBe(2);
  });

  it('fits on SLOT, not on epoch ms', () => {
    // A fit against timestamps would give a slope of order 1e-8 price per millisecond and would be
    // drawn as a line that leaves its own fitted values wherever a weekend falls (§11.2: the x-axis
    // is slot-linear). The magnitude is the tell.
    const fit = regressionFit(from, to, contextFor(FULL));
    expect(Math.abs(fit?.slope ?? 0)).toBeGreaterThan(1e-4);
    expect(fit?.slot0).toBe(300);
    expect(fit?.slot1).toBe(900);
  });

  it('skips a NaN close rather than poisoning the fit', () => {
    const gapped = Float64Array.from(CLOSES);
    gapped[500] = Number.NaN;
    const fit = regressionFit(from, to, { ...contextFor(FULL), closes: gapped });
    expect(fit?.n).toBe(600);
    expect(Number.isFinite(fit?.slope ?? Number.NaN)).toBe(true);
  });

  it('refuses a window olsRegression cannot take (n < 3) instead of throwing on the frame path', () => {
    expect(regressionFit(anchorOfBar(300), anchorOfBar(301), contextFor(FULL))).toBeNull();
    expect(regressionFit(from, to, { ...contextFor(FULL), closes: null })).toBeNull();
  });

  it('draws the band at ± 2σ of the mid-line', () => {
    const geometry = projectAnnotation(annotation('regression_channel', [300, 900]), contextFor(FULL));
    if (geometry?.kind !== 'regression_channel') throw new Error('no channel');
    const scales = scalesFor(FULL);
    const midValue = geometry.fit.intercept + geometry.fit.slope * geometry.fit.slot0;
    const band = REGRESSION_SIGMAS * geometry.fit.stdev;
    expect(geometry.mid[0].y).toBeCloseTo(scales.y(midValue), 10);
    expect(geometry.upper[0].y).toBeCloseTo(scales.y(midValue + band), 10);
    expect(geometry.lower[0].y).toBeCloseTo(scales.y(midValue - band), 10);
    // Upper is ABOVE mid on screen: y grows downward, and getting this backwards is a channel drawn
    // inside out that still passes every arithmetic assertion above.
    expect(geometry.upper[0].y).toBeLessThan(geometry.mid[0].y);
    expect(geometry.lower[0].y).toBeGreaterThan(geometry.mid[0].y);
  });
});

describe('trendline extension (Shift+X, §11.8)', () => {
  it('extends to the right edge of the plot, keeping the slope', () => {
    const shape = annotation('trendline', [300, 900]);
    const plain = projectAnnotation(shape, contextFor(ZOOMED));
    const extended = projectAnnotation(shape, contextFor(ZOOMED, { extendRight: true }));
    if (plain?.kind !== 'trendline' || extended?.kind !== 'trendline') throw new Error('no line');
    expect(extended.line[0]).toEqual(plain.line[0]);
    expect(extended.line[1].x).toBe(PLOT.x + PLOT.w);
    const slope = (p: { line: readonly [{ x: number; y: number }, { x: number; y: number }] }): number =>
      (p.line[1].y - p.line[0].y) / (p.line[1].x - p.line[0].x);
    expect(slope(extended)).toBeCloseTo(slope(plain), 10);
  });
});

describe('hit testing (§11.1)', () => {
  const ctx = contextFor(FULL);
  const shapes = [annotation('trendline', [300, 900])];

  it('finds the body of a shape within tolerance and nothing outside it', () => {
    const geometry = projectAnnotation(shapes[0]!, ctx);
    if (geometry?.kind !== 'trendline') throw new Error('no line');
    const mid = {
      x: (geometry.line[0].x + geometry.line[1].x) / 2,
      y: (geometry.line[0].y + geometry.line[1].y) / 2,
    };
    expect(hitTestAnnotations(shapes, ctx, mid.x, mid.y + 2)).toEqual({
      kind: 'annotation',
      index: 0,
      anchor: null,
    });
    expect(hitTestAnnotations(shapes, ctx, mid.x, mid.y + ANNOTATION_HIT_PX * 5)).toBeNull();
  });

  it('prefers an anchor to a body, because the next key is M and not Delete', () => {
    const point = anchorPoint(anchorOfBar(900), SLOTS, ctx.scales);
    expect(hitTestAnnotations(shapes, ctx, point.x, point.y)).toEqual({
      kind: 'annotation',
      index: 1 - 1,
      anchor: 1,
    });
  });

  it('reports the later annotation on a tie, which is z-order', () => {
    const two = [annotation('hline', [500]), annotation('hline', [500])];
    const y = ctx.scales.y(anchorOfBar(500).v);
    expect(hitTestAnnotations(two, ctx, PLOT.x + 400, y)?.index).toBe(1);
  });

  it('does not select a rect by its interior', () => {
    const rect = [annotation('rect', [300, 900])];
    const geometry = projectAnnotation(rect[0]!, ctx);
    if (geometry?.kind !== 'rect') throw new Error('no rect');
    const centre = {
      x: geometry.rect.x + geometry.rect.w / 2,
      y: geometry.rect.y + geometry.rect.h / 2,
    };
    // A filled rect over six months of price would otherwise swallow every click meant for the
    // series underneath it.
    expect(hitTestAnnotations(rect, ctx, centre.x, centre.y)).toBeNull();
    expect(hitTestAnnotations(rect, ctx, centre.x, geometry.rect.y + 1)?.anchor).toBeNull();
  });
});

describe('serialisation to chart_annotations (CHRT-05, migration 0012 L113)', () => {
  /** The `kind IN (…)` CHECK — the authority on which kinds the column accepts. */
  const checkedKinds = ((): string[] => {
    const table = MIGRATION_0012.slice(MIGRATION_0012.indexOf('CREATE TABLE chart_annotations'));
    const ddl = table.slice(0, table.indexOf(');'));
    const m = /CHECK \(kind IN \(([^)]*)\)\)/.exec(ddl);
    expect(m?.[1], 'migration 0012 no longer CHECKs chart_annotations.kind').toBeDefined();
    return (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  })();

  const options = {
    instrumentId: 4242,
    sharedScope: 'firm' as const,
    sharedUserIds: [7, 9],
    style: { color: '#ff8800', width: 2 },
    fit: null,
  };

  it('every kind serialises to a body the SDK schema accepts', () => {
    for (const kind of checkedKinds as ChartAnnotation['kind'][]) {
      const anchors = kind === 'hline' || kind === 'vline' || kind === 'text' ? [400] : [300, 900];
      const shape = annotation(kind, anchors, { label: 'March low' });
      const fit = kind === 'regression_channel' ? regressionFit(shape.anchors[0]!, shape.anchors[1]!, contextFor(FULL)) : null;
      const body = serialiseAnnotation(shape, { ...options, fit });
      // The real request schema, not a transcription of it: this is what `Ctrl+S` sends.
      expect(() => ChartAnnotationInput.parse(body)).not.toThrow();
      expect(checkedKinds).toContain(body.kind);
    }
  });

  it('writes anchors as [{t: epoch_ms, v}] with integer instants', () => {
    const body = serialiseAnnotation(annotation('trendline', [300, 900]), options);
    expect(body.anchors).toEqual([
      { t: X[300], v: CLOSES[300] },
      { t: X[900], v: CLOSES[900] },
    ]);
    for (const anchor of body.anchors) expect(Number.isInteger(anchor.t)).toBe(true);
    // A fractional millisecond matches no bar, so on reload `nearestSlot` would round it to a neighbour
    // and the annotation would come back one bar from where it was drawn.
    const drifted: ChartAnnotation = {
      annotationId: null,
      kind: 'vline',
      anchors: [{ t: (X[400] ?? 0) + 0.4, v: 1 }],
      editable: true,
    };
    expect(serialiseAnnotation(drifted, options).anchors[0]?.t).toBe(X[400]);
  });

  it('keeps a regression_channel in {t, v} anchors and puts σ in style', () => {
    const shape = annotation('regression_channel', [300, 900]);
    const fit = regressionFit(shape.anchors[0]!, shape.anchors[1]!, contextFor(FULL));
    const body = serialiseAnnotation(shape, { ...options, fit });
    // The SQL column comment describes a `{t0, t1, stdev}` variant; the only API that writes the
    // table declares `anchors: z.array(z.object({ t, v }))` and would reject it, so `Ctrl+S` would
    // fail on the one kind that most needs persisting. σ rides `style` (jsonb) instead.
    expect(Object.keys(body.anchors[0] ?? {}).sort()).toEqual(['t', 'v']);
    expect(body.style).toMatchObject({ stdev: fit?.stdev, sigmas: 2 });
    expect(() => ChartAnnotationInput.parse(body)).not.toThrow();
  });

  it('sends label null rather than omitting it', () => {
    const body = serialiseAnnotation(annotation('hline', [400]), options);
    expect(body.label).toBeNull();
    expect(() => ChartAnnotationInput.parse(body)).not.toThrow();
  });
});

describe('rehydrating a persisted annotation (§11.8)', () => {
  const record: ChartAnnotationRecord = {
    annotationId: 77,
    instrumentId: 4242,
    ownerUserId: 3,
    kind: 'trendline',
    anchors: [
      { t: X[300] ?? 0, v: CLOSES[300] ?? 0 },
      { t: X[900] ?? 0, v: CLOSES[900] ?? 0 },
    ],
    style: {},
    label: null,
    sharedScope: 'firm',
    sharedUserIds: [],
    updatedAt: '2026-09-15T18:41:28.000Z',
  };

  it('round-trips a row back to the spec shape and onto the same pixels', () => {
    const parsed = ChartAnnotationInput.parse({ ...record, annotationId: undefined, ownerUserId: undefined, updatedAt: undefined });
    expect(parsed.anchors).toHaveLength(2);
    const rehydrated = annotationFromRecord(record, false);
    if (rehydrated === null) throw new Error('the record did not rehydrate');
    expect(rehydrated.editable).toBe(false);
    expect(projectAnnotation(rehydrated, contextFor(ZOOMED))).toEqual(
      projectAnnotation(annotation('trendline', [300, 900]), contextFor(ZOOMED)),
    );
  });

  it('leaves label ABSENT, not undefined, when the row has none (exactOptionalPropertyTypes)', () => {
    const rehydrated = annotationFromRecord(record, true);
    expect(rehydrated).not.toBeNull();
    expect('label' in (rehydrated ?? {})).toBe(false);
    expect(annotationFromRecord({ ...record, label: 'March low' }, true)?.label).toBe('March low');
  });

  it('refuses the legacy {t0, t1, stdev} anchor shape rather than drawing it at v = 0', () => {
    // It carries no value coordinate, so it cannot be rehydrated at all — a channel along the bottom
    // of the pane is worse than no channel. No writer in this build produces it.
    const legacy = {
      ...record,
      kind: 'regression_channel' as const,
      anchors: [{ t0: X[300], t1: X[900], stdev: 3.2 }],
    } as unknown as ChartAnnotationRecord;
    expect(annotationFromRecord(legacy, true)).toBeNull();
  });

  it('refuses a row with fewer anchors than its kind takes', () => {
    expect(annotationFromRecord({ ...record, anchors: [record.anchors[0]!] }, true)).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Event markers (CHRT-06, §11.7) — see the file header for why they are asserted here             */
/* -------------------------------------------------------------------------------------------- */

const FONTS: ChartFonts = {
  axis: '400 11px "IBM Plex Mono", monospace',
  label: '500 11px "IBM Plex Mono", monospace',
  readout: '500 11px "IBM Plex Mono", monospace',
  lineHeightPx: 14,
  digitPx: 6.6,
};

/** The event band as `PaneLayout` reports it: one row, at the bottom of the main pane's plot. */
const BAND: Rect = { x: PLOT.x, y: PLOT.y + PLOT.h - FONTS.lineHeightPx, w: PLOT.w, h: FONTS.lineHeightPx };

/** The 20 real dividends of the fixture, as `ChartSpec.events[]` (`CACS` is §11.7's own example). */
const DIVIDEND_EVENTS: ChartEvent[] = FIXTURE.dividends.map((d, i) => ({
  t: d.exTsMs,
  kind: 'dividend',
  label: `Dividend ${d.amount.toFixed(2)} ${d.currency} ex ${d.exDate}`,
  command: 'CACS',
  provIdx: i + 1,
}));

function bandInput(overrides: { plot?: Rect; band?: Rect } = {}) {
  const view = FULL;
  const scales = scalesFor(view, overrides.plot ?? PLOT);
  return {
    band: overrides.band ?? BAND,
    plot: overrides.plot ?? PLOT,
    fonts: FONTS,
    slotOf: (t: number) => exactSlotOf(t),
    x: (slot: number) => scales.x(slot),
  };
}

describe('the marker glyph table (§11.7)', () => {
  it('is the eight kinds CLIENT.md §11.7 names, with the glyphs it spells', () => {
    const kinds = /\(`(earnings[^`]*)`\)/.exec(CLIENT_MD)?.[1]?.split(/\s+/) ?? [];
    expect(kinds).toHaveLength(8);
    expect([...EVENT_KINDS]).toEqual(kinds);
    const glyphs = /\(`(E D S N F [^`]*)`\)/.exec(CLIENT_MD)?.[1]?.split(' ') ?? [];
    expect(glyphs, 'CLIENT.md §11.7 no longer spells the glyph row').toHaveLength(8);
    expect(EVENT_KINDS.map((kind) => EVENT_GLYPH[kind])).toEqual(glyphs);
  });
});

describe('the event band, over 20 real dividends (CHRT-06)', () => {
  it('places every dividend at the slot of its ex-date, one row, in time order', () => {
    const markers = layoutEventMarkers(DIVIDEND_EVENTS, bandInput());
    expect(markers).toHaveLength(20);
    expect(markers.every((m) => m.glyph === 'D')).toBe(true);
    expect(markers.every((m) => m.row === 0)).toBe(true);
    expect(markers.every((m) => m.rect.y === BAND.y)).toBe(true);
    expect(markers.every((m) => m.rect.w >= MARKER_MIN_HIT_PX)).toBe(true);
    // Slot order, which is time order, which is the focus order.
    const slots = markers.map((m) => m.slot);
    expect([...slots].sort((a, b) => a - b)).toEqual(slots);
    // The glyph is centred on the slot's x.
    const first = markers[0];
    if (first === undefined) throw new Error('no markers');
    expect(first.rect.x + first.rect.w / 2).toBeCloseTo(bandInput().x(first.slot), 10);
    expect(markerOfEvent(markers, first.index)).toBe(first);
  });

  it('drops an event whose t precedes the first bar instead of drawing it at slot 0', () => {
    const early: ChartEvent = {
      t: (X[0] ?? 0) - 30 * 86_400_000,
      kind: 'earnings',
      label: 'Q3 2021',
      command: 'ERN',
      provIdx: 99,
    };
    const markers = layoutEventMarkers([early, ...DIVIDEND_EVENTS], bandInput());
    expect(markers).toHaveLength(20);
    expect(markers.some((m) => m.index === 0)).toBe(false);
    // The spec indices of the survivors are still THEIR indices, shifted by the dropped one: a
    // marker that carried its position in the markers array instead would run the wrong command.
    expect(markers[0]?.index).toBe(1);
  });

  it('stacks markers that share a slot upward out of the one-row band', () => {
    const shared = (X[600] ?? 0);
    const events: ChartEvent[] = [
      { t: shared, kind: 'earnings', label: 'Q2', command: 'ERN', provIdx: 1 },
      { t: shared, kind: 'dividend', label: 'div', command: 'CACS', provIdx: 2 },
      { t: shared, kind: 'filing', label: '10-Q', command: 'CF', provIdx: 3 },
    ];
    const markers = layoutEventMarkers(events, bandInput());
    expect(markers.map((m) => m.row)).toEqual([0, 1, 2]);
    expect(markers.map((m) => m.rect.y)).toEqual([
      BAND.y,
      BAND.y - FONTS.lineHeightPx,
      BAND.y - 2 * FONTS.lineHeightPx,
    ]);
    expect(markers.map((m) => m.glyph)).toEqual(['E', 'D', 'F']);
    expect(markers.every((m) => m.rect.y >= PLOT.y)).toBe(true);
  });

  it('clamps the stack to the rows that fit, and keeps every marker reachable by key', () => {
    // Two rows of room, five events on one slot. The overflow shares the top row — the mouse can
    // only reach the first of them — but the focus order still visits all five, so `Enter` can still
    // run the command of an occluded marker (TERM-06).
    const shortPlot: Rect = { x: 60, y: 100, w: 800, h: 2 * FONTS.lineHeightPx };
    const shortBand: Rect = {
      x: shortPlot.x,
      y: shortPlot.y + shortPlot.h - FONTS.lineHeightPx,
      w: shortPlot.w,
      h: FONTS.lineHeightPx,
    };
    const shared = X[600] ?? 0;
    const events: ChartEvent[] = Array.from({ length: 5 }, (_unused, i) => ({
      t: shared,
      kind: 'news' as const,
      label: `headline ${String(i)}`,
      command: 'AAPL US Equity CN',
      provIdx: i,
    }));
    const markers = layoutEventMarkers(events, bandInput({ plot: shortPlot, band: shortBand }));
    expect(markers.map((m) => m.row)).toEqual([0, 1, 1, 1, 1]);
    expect(markers.every((m) => m.rect.y >= shortPlot.y)).toBe(true);
    expect(markers.map((m) => m.index)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('marker hit testing and focus order (§11.7, TERM-06)', () => {
  const markers = layoutEventMarkers(DIVIDEND_EVENTS, bandInput());

  it('reports the marker under the pointer in data coordinates', () => {
    const target = markers[7];
    if (target === undefined) throw new Error('no marker');
    const hit = hitTestEventMarkers(
      markers,
      target.rect.x + target.rect.w / 2,
      target.rect.y + target.rect.h / 2,
    );
    expect(hit).toEqual({ kind: 'event', index: target.index, slot: target.slot });
  });

  it('reports nothing above the band or between two markers', () => {
    const target = markers[7];
    if (target === undefined) throw new Error('no marker');
    expect(hitTestEventMarkers(markers, target.rect.x + target.rect.w / 2, PLOT.y + 5)).toBeNull();
    expect(
      hitTestEventMarkers(markers, target.rect.x + 40, target.rect.y + target.rect.h / 2),
    ).toBeNull();
  });

  it('Ctrl+Arrow walks every marker in time order and stops at the ends', () => {
    expect(nextEventMarker(markers, null, 1)).toBe(markers[0]);
    expect(nextEventMarker(markers, null, -1)).toBe(markers[markers.length - 1]);

    const walked: number[] = [];
    let current = nextEventMarker(markers, null, 1);
    while (current !== null) {
      walked.push(current.index);
      current = nextEventMarker(markers, current.index, 1);
    }
    expect(walked).toEqual(markers.map((m) => m.index));

    // No wrapping: `Ctrl+ArrowRight` at the last marker must not jump the crosshair across five
    // years of chart.
    expect(nextEventMarker(markers, markers[markers.length - 1]?.index ?? 0, 1)).toBeNull();
    expect(nextEventMarker(markers, markers[0]?.index ?? 0, -1)).toBeNull();
    expect(nextEventMarker([], null, 1)).toBeNull();
  });

  it('carries the command and the provIdx the keys need, without a second lookup', () => {
    const marker = nextEventMarker(markers, null, 1);
    expect(marker?.event.command).toBe('CACS');
    expect(marker?.event.provIdx).toBe(DIVIDEND_EVENTS[marker?.index ?? 0]?.provIdx);
    expect(marker?.event.label).toContain('ex ');
  });

  it('sends focus to an end when the focused event has fallen off the axis', () => {
    expect(nextEventMarker(markers, 9_999, 1)).toBe(markers[0]);
    expect(nextEventMarker(markers, 9_999, -1)).toBe(markers[markers.length - 1]);
  });
});
