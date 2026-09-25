/**
 * `packages/web/test/grid/frame-budget.bench.ts` — WP-13's NFR-02 acceptance row (WORKPLAN L1429):
 * *"a burst of 5 000 field updates stays inside one animation frame budget"*, with CLIENT.md §10.6
 * and TESTING.md §13's sustained form of the same budget: 2 000 visible cells receiving 5 000 field
 * changes per second keep the rAF callback under 8 ms p95 in jsdom-instrumented timing.
 *
 * **This is a vitest TEST, not a reporting benchmark**, for the reason `core/test/command/
 * command.bench.ts` and `web/test/shell/autocomplete.bench.ts` are: a budget that only prints a
 * number is a budget nobody notices breaking. Every number below is asserted, and this file fails
 * the suite when the tick path regresses. (The `web` project's vitest `include` carries
 * `test/**\/*.bench.{ts,tsx}` for exactly this.)
 *
 * WHAT IS TIMED IS THE ANIMATION FRAME, AND NOTHING ELSE IS SMUGGLED INTO IT. The frame pump of
 * `test/setup.tsx` (TESTING.md §2.2) is the only timing source: `requestAnimationFrame` QUEUES a
 * callback, and `flushFrames(n)` runs n frames and returns each one's synchronous duration measured
 * with `performance.now()` around the callback. No `setTimeout` is waited on anywhere in this file.
 * What runs inside that measured window is `CellRegistry.flush()` — the real one, on a real mounted
 * `LiveGrid`, writing real DOM elements.
 *
 * AND NOTHING ON THE PATH IS HAND-BUILT. WP-12's audit found tests that proved a capability through
 * an object no real payload produces, and passed by construction. So the frames here are built as
 * the server builds them and parsed by `wire/ws.ts`'s own zod schemas — the normative wire
 * definition WP-06's server tests are written against — then applied through the SDK's real
 * `QuoteCache`, with its real prev-chain rule. The registry is fed whatever came out of that. A
 * budget measured over a synthetic `QuoteView` would be measuring a shape the socket never sends.
 *
 * THE BUDGET ONLY HOLDS IF REACT IS OFF THE TICK PATH, so the React commit count of the grid's own
 * subtree is asserted at zero across every measured run. If a refactor ever routes a delta through
 * React state, this file reports the commits *and* the milliseconds they cost.
 *
 * ONE MEASURED NUMBER DOES NOT MAKE THE FIGURE THE WORKPLAN ROW QUOTES, AND IT IS SAID HERE RATHER
 * THAN ARRANGED AWAY. Read as five thousand updates inside a *single* frame, the burst costs about
 * 44-49 ms in jsdom against a 16 ms frame — measured, printed on every run, and reported to the
 * integrator. It is not the grid: the same test measures jsdom's floor for the bare DOM writes that
 * any implementation must perform on those 2 200 cells, and that floor alone is ~28 ms. No grid can
 * make 16 ms here, so asserting it would fail correct code for a property of the instrument. The
 * design agrees: TESTING.md §16 L958 assigns the 16 ms browser figure to
 * `packages/e2e/tests/live-grid.spec.ts` and the 8 ms jsdom figure to the sustained
 * 2 000-cell / 5 000-changes-per-second load — which is the second test below, and which passes at
 * roughly a third of its budget. What this file asserts of the burst is the claim jsdom can carry:
 * one frame, one write per cell, the latest value, zero React commits, and a total within a small
 * factor of the DOM writes themselves.
 *
 * A consequence worth the integrator's attention is printed too: at the per-write cost measured
 * here, `MAX_WRITES_PER_FRAME = 2 500` (CLIENT.md §10.4) permits a ~55 ms frame in jsdom. The cap is
 * a round number rather than one derived from a measured write cost, and the third test below shows
 * a real capped frame costing 46 ms.
 *
 * THE SUSTAINED TEST RUNS THE SAME FIVE SECONDS THREE TIMES, AND ASSERTS THAT THE THIRD COSTS WHAT
 * THE FIRST DID. That is not padding. A budget measured once cannot see state accumulating on the
 * tick path, and there is some: with flashes enabled the p95 of identical rounds was measured at
 * 3.1 / 5.5 / 9.8 ms, and with `flashMs: 0` at 1.5 / 1.5 / 1.5 ms — flat. The cost is in
 * `flash.ts#trigger`, which attaches an `animationend` listener per flash and relies on that event
 * to remove it; `clear`, `endFlash` and `sweep` all take the class and the map entry off but leave
 * the listener attached, so wherever the animation does not run to completion — jsdom, a
 * `display:none` panel, `prefers-reduced-motion`, an element unmounted mid-animation — one listener
 * per flash per cell accumulates without bound. A single-round p95 passes over it; the drift
 * assertion does not.
 */
import { Profiler, createElement } from 'react';
import type { ProfilerOnRenderCallback, ReactElement } from 'react';

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { format } from '@terminal/core';
import { Delta, QuoteCache, Snap } from '@terminal/sdk';

import {
  CellRegistry,
  CellRegistryContext,
  MAX_WRITES_PER_FRAME,
} from '../../src/grid/cellRegistry.js';
import { LiveGrid } from '../../src/grid/LiveGrid.js';
import type { Cell, GridColumn, GridRow } from '../../src/screen/types.js';
import { flushFrames, pendingFrames } from '../setup.js';

/* ---------------------------------------------------------------------------------------------- */
/* The budgets — both from the design, both asserted                                                */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One animation frame at 60 Hz. The WORKPLAN row's "one animation frame budget", and NFR-02's
 * browser figure (ARCHITECTURE §6.6, TESTING.md §16: "rAF < 8 ms p95 jsdom / < 16 ms browser").
 */
const FRAME_BUDGET_MS = 16;

/** NFR-02's jsdom figure: the p95 of the rAF callback under the sustained 5 000 changes/s load. */
const SUSTAINED_P95_BUDGET_MS = 8;

/** WORKPLAN L1429: the burst is five thousand *field* updates, not five thousand frames. */
const BURST_FIELD_UPDATES = 5_000;

/** CLIENT.md §10.6 / TESTING.md §13: 5 000 field changes per second, for five seconds, at 60 Hz. */
const SUSTAINED_CHANGES_PER_SECOND = 5_000;
const SUSTAINED_SECONDS = 5;
const FRAMES_PER_SECOND = 60;
const SUSTAINED_FRAMES = SUSTAINED_SECONDS * FRAMES_PER_SECOND;
const SUSTAINED_CHANGES = SUSTAINED_CHANGES_PER_SECOND * SUSTAINED_SECONDS;

/* ---------------------------------------------------------------------------------------------- */
/* The payload: 1 000 rows, ten live columns, a 2 000-cell visible window (CLIENT.md §10.6)         */
/* ---------------------------------------------------------------------------------------------- */

const ROW_COUNT = 1_000;
const ROW_HEIGHT = 20;

/**
 * 4 000 px of viewport is 200 rows, and `virtualiser.ts` adds ten rows of overscan either side, so
 * 220 rows × 10 live columns = 2 200 live cells are registered — the "2 000 visible cells" of
 * CLIENT.md §10.6, rounded up by the overscan the real grid always carries.
 */
const VIEWPORT_PX = 4_000;

/** Wide enough that a single burst over every visible cell exceeds `MAX_WRITES_PER_FRAME`. */
const TALL_VIEWPORT_PX = 5_200;

const LIVE_FIELDS = [
  'PX_LAST',
  'PX_BID',
  'PX_ASK',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'VWAP',
  'CHG_PCT_1D',
] as const;

const FMT_OF: Record<string, NonNullable<GridColumn['fmt']>> = {
  PX_LAST: 'px',
  PX_BID: 'px',
  PX_ASK: 'px',
  PX_OPEN: 'px',
  PX_HIGH: 'px',
  PX_LOW: 'px',
  PX_CLOSE_1D: 'px',
  PX_VOLUME: 'int',
  VWAP: 'px',
  CHG_PCT_1D: 'pct',
};

const COLUMNS: GridColumn[] = [
  { id: 'ticker', label: 'Ticker', fmt: 'text', width: 10, sortable: true },
  ...LIVE_FIELDS.map((field) => ({
    id: field,
    label: field,
    fieldId: field,
    fmt: FMT_OF[field],
    live: true,
    align: 'right' as const,
    width: 12,
  })),
];

const TS_BASE = 1_789_497_688_000;

function baseValue(rowIndex: number, field: string): number {
  const seed = rowIndex + 1;
  if (field === 'PX_VOLUME') return seed * 1_000;
  if (field === 'CHG_PCT_1D') return ((seed % 7) - 3) / 10;
  return 100 + seed / 10;
}

/** The value of one field at generation `n` — every generation moves every field. */
function valueAt(rowIndex: number, field: string, generation: number): number {
  if (field === 'PX_VOLUME') return baseValue(rowIndex, field) + generation * 1_000;
  if (field === 'CHG_PCT_1D') return baseValue(rowIndex, field) + generation * 0.01;
  return baseValue(rowIndex, field) + generation * 0.01;
}

function makeRows(count = ROW_COUNT): GridRow[] {
  const rows: GridRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const cells: Record<string, Cell> = {
      ticker: { v: `T${String(i)}`, st: 'live', provIdx: 0, fmt: 'text' },
    };
    for (const field of LIVE_FIELDS) {
      cells[field] = {
        v: baseValue(i, field),
        st: 'live',
        provIdx: 1,
        fieldId: field,
        fmt: FMT_OF[field],
        ts: TS_BASE,
      };
    }
    rows.push({ id: `r${String(i)}`, subject: `q:${String(i)}`, cells });
  }
  return rows;
}

/* ---------------------------------------------------------------------------------------------- */
/* Wire frames, through the normative schemas                                                       */
/* ---------------------------------------------------------------------------------------------- */

function snapFor(rowIndex: number, seq: number): Snap {
  const f: Record<string, number> = {};
  const fts: Record<string, number> = {};
  for (const field of LIVE_FIELDS) {
    f[field] = baseValue(rowIndex, field);
    fts[field] = TS_BASE;
  }
  return Snap.parse({
    t: 'snap',
    s: `q:${String(rowIndex)}`,
    seq,
    tier: 'delayed',
    reason: 'SOURCE_TIER_CAP',
    f,
    fts,
    ts: { src: TS_BASE, cap: TS_BASE + 10, pub: TS_BASE + 11 },
    st: 'live',
    session: 'open',
    prov: { p: 'cboe.quotes', id: 88_213, seq: 15_972_883_317 },
    ac: 'equity',
    id: rowIndex,
  });
}

/** One conflated flush for a subject: every subscribed field at generation `generation`. */
function deltaFor(rowIndex: number, seq: number, prev: number, generation: number): Delta {
  const f: Record<string, number> = {};
  const fts: Record<string, number> = {};
  for (const field of LIVE_FIELDS) {
    f[field] = valueAt(rowIndex, field, generation);
    fts[field] = TS_BASE + seq;
  }
  return Delta.parse({
    t: 'delta',
    s: `q:${String(rowIndex)}`,
    seq,
    prev,
    f,
    fts,
    ts: { src: TS_BASE + seq, cap: TS_BASE + seq + 1, pub: TS_BASE + seq + 2 },
    st: 'live',
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* Harness                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

interface Bed {
  registry: CellRegistry;
  cache: QuoteCache;
  /** Row indices whose cells are registered — the visible window, taken from the registry itself. */
  visible: number[];
  /** The live cell count: subjects × live columns. */
  cells: number;
  /** Apply one frame through the real cache and queue whatever it says changed. */
  feed(frame: Snap | Delta): void;
  /** Send one conflated flush per visible subject at `generation`; returns the field updates sent. */
  sweepGeneration(generation: number, limit: number): number;
  /** One conflated flush for one subject, chained onto whatever `seq` it last received. */
  feedGeneration(rowIndex: number, generation: number): void;
  commits(): number;
}

let clientHeightSpy: PropertyDescriptor | undefined;
let viewportPx = VIEWPORT_PX;

function stubViewportHeight(): void {
  clientHeightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains('grid__viewport') ? viewportPx : 0;
    },
  });
}

function restoreViewportHeight(): void {
  viewportPx = VIEWPORT_PX;
  if (clientHeightSpy === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    return;
  }
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightSpy);
  clientHeightSpy = undefined;
}

function mountBed(): Bed {
  const registry = new CellRegistry();
  const cache = new QuoteCache();
  let commits = 0;
  const onRender: ProfilerOnRenderCallback = () => {
    commits += 1;
  };

  const grid: ReactElement = createElement(LiveGrid, {
    id: 'bench',
    columns: COLUMNS,
    rows: makeRows(),
    rowHeight: ROW_HEIGHT,
    live: { subjectOf: (row: GridRow) => row.subject ?? null },
  });
  render(
    createElement(
      Profiler,
      { id: 'grid', onRender },
      createElement(CellRegistryContext.Provider, { value: registry }, grid),
    ),
  );

  // The visible set is read off the registry rather than assumed: whatever the virtualiser decided
  // to mount is what the budget is being measured over.
  const visible = registry
    .subjects()
    .map((subject) => Number(subject.slice(2)))
    .sort((a, b) => a - b);
  const cells = registry.size;
  const seqOf = new Map<number, number>();

  const bed: Bed = {
    registry,
    cache,
    visible,
    cells,
    feed(frame) {
      const result = cache.apply(frame);
      const state = cache.get(frame.s);
      if (state === undefined) throw new Error(`no view for ${frame.s}`);
      if (result.resyncNeeded) throw new Error(`unexpected gap on ${frame.s}`);
      registry.apply({ subject: frame.s, changed: result.changed, state });
    },
    sweepGeneration(generation, limit) {
      let sent = 0;
      for (const index of visible) {
        if (sent >= limit) break;
        bed.feedGeneration(index, generation);
        sent += LIVE_FIELDS.length;
      }
      return sent;
    },
    feedGeneration(rowIndex, generation) {
      const prev = seqOf.get(rowIndex) ?? 0;
      const seq = prev + 1;
      seqOf.set(rowIndex, seq);
      bed.feed(deltaFor(rowIndex, seq, prev, generation));
    },
    commits: () => commits,
  };

  // The opening snapshot, exactly as the server sends it after `subAck` (API.md §6.3 step 2). It
  // restates the payload, so it writes nothing — the burst below starts from a painted grid.
  for (const index of visible) {
    seqOf.set(index, 4_182);
    bed.feed(snapFor(index, 4_182));
  }
  flushFrames(1);

  return bed;
}

function cellEl(subject: string, field: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-subject="${subject}"][data-field="${field}"]`,
  );
  if (el === null) throw new Error(`no cell on screen for ${subject} ${field}`);
  return el;
}

/**
 * jsdom's own price for the DOM mutation `CellRegistry.#write` cannot avoid.
 *
 * Every cell whose value moved has to be written, and a write is five property sets: `textContent`,
 * `data-st`, `data-dir`, `aria-label` and `title`. This does exactly those, on exactly the grid's
 * own cell elements, with no registry, no lookup, no formatting and no flash — so the number it
 * returns is the lower bound on ANY implementation's frame in this environment. It is measured
 * rather than assumed, because the whole question the budget raises is what share of the frame is
 * the grid's doing and what share is the instrument's.
 *
 * It overwrites every cell, so it runs after the value assertions.
 */
function domFloorMs(bed: Bed): number {
  const cells = [
    ...document.querySelectorAll<HTMLElement>('[role="gridcell"][data-subject][data-field]'),
  ];
  expect(cells).toHaveLength(bed.cells);
  const text = '330.27';
  const label = 'PX_LAST: 330.27, live';
  const title = 'live · 2026-05-04T12:00:00.000Z';

  const started = performance.now();
  for (const el of cells) {
    el.textContent = text;
    el.setAttribute('data-st', 'live');
    el.setAttribute('data-dir', 'up');
    el.setAttribute('aria-label', label);
    el.title = title;
  }
  return performance.now() - started;
}

/* ---------------------------------------------------------------------------------------------- */
/* Statistics                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

const ms = (n: number): string => n.toFixed(3);

/* ---------------------------------------------------------------------------------------------- */

beforeEach(stubViewportHeight);
afterEach(restoreViewportHeight);

describe('NFR-02 — the grid holds the frame budget (WORKPLAN L1429, CLIENT.md §10.6)', () => {
  it('drains a burst of 5 000 field updates in ONE frame, at little over the cost of the writes', () => {
    const bed = mountBed();
    expect(bed.cells).toBeGreaterThanOrEqual(2_000);
    expect(bed.registry.stats.writes).toBe(0); // the snapshot restated the payload

    const commitsBefore = bed.commits();
    const rounds: { frameMs: number; writes: number; ingestMs: number; sent: number }[] = [];
    let generation = 0;

    // One untimed warm-up burst, then three measured ones: the assertion is on the MEDIAN, because
    // one round's duration on a loaded machine can be one GC pause, while a real regression moves
    // every round together.
    for (let round = 0; round < 4; round += 1) {
      const writesBefore = bed.registry.stats.writes;
      const framesBefore = bed.registry.stats.frames;

      // 5 000 field updates, delivered as the server delivers them: one conflated flush per subject
      // per generation, ten fields each, every one of them a value that actually moved.
      const ingestStart = performance.now();
      let sent = 0;
      while (sent < BURST_FIELD_UPDATES) {
        generation += 1;
        sent += bed.sweepGeneration(generation, BURST_FIELD_UPDATES - sent);
      }
      const ingestMs = performance.now() - ingestStart;
      expect(sent).toBe(BURST_FIELD_UPDATES);

      // `apply` never writes: five thousand updates have scheduled exactly one animation frame.
      expect(pendingFrames()).toBe(1);

      const durations = flushFrames(1);
      expect(durations).toHaveLength(1);
      expect(bed.registry.stats.frames).toBe(framesBefore + 1);

      // ONE frame, and the queue is empty afterwards: nothing was carried over, nothing deferred.
      expect(pendingFrames()).toBe(0);
      expect(bed.registry.stats.deferred).toBe(0);

      // Five thousand updates over 2 200 cells coalesced to one write per cell carrying the latest
      // value — the latest-value guarantee (API.md §6.4) surviving all the way to the DOM.
      const writes = bed.registry.stats.writes - writesBefore;
      expect(writes).toBe(bed.cells);

      if (round > 0) rounds.push({ frameMs: durations[0]!, writes, ingestMs, sent });
    }

    // The number on screen at the end is the last one sent, not the first — asserted before the
    // floor measurement below, which overwrites every cell.
    const subject = `q:${String(bed.visible[0]!)}`;
    expect(cellEl(subject, 'PX_LAST').textContent).toBe(
      format('PX_LAST', valueAt(bed.visible[0]!, 'PX_LAST', generation), {}),
    );

    const frameMs = rounds.map((r) => r.frameMs);
    const medianFrameMs = median(frameMs);
    const perWriteUs = (medianFrameMs / bed.cells) * 1_000;

    // The floor: the SAME number of cells, the same five property writes, straight onto the same
    // elements, with no registry and no formatting. This is what jsdom charges for the DOM
    // mutation the grid cannot avoid — every cell whose value moved has to be written — and it is
    // measured here, in this process, on this machine, rather than assumed.
    const floorMs = median([
      domFloorMs(bed),
      domFloorMs(bed),
      domFloorMs(bed),
      domFloorMs(bed),
      domFloorMs(bed),
    ]);
    const overhead = medianFrameMs / floorMs;

    process.stdout.write(
      [
        `[NFR-02 burst] ${String(bed.visible.length)} subjects × ${String(LIVE_FIELDS.length)} live columns = ${String(bed.cells)} visible cells`,
        `  ${String(BURST_FIELD_UPDATES)} field updates per burst → 1 rAF, ${String(rounds[0]?.writes ?? 0)} cell writes`,
        `  frame median ${ms(medianFrameMs)} ms (rounds ${frameMs.map(ms).join(' / ')}) — ${perWriteUs.toFixed(1)} µs per cell write`,
        `  jsdom floor for the same ${String(bed.cells)} bare DOM writes ${ms(floorMs)} ms → the registry costs ${overhead.toFixed(2)}× the floor`,
        `  the ${String(MAX_WRITES_PER_FRAME)}-write cap therefore permits a ~${ms((perWriteUs * MAX_WRITES_PER_FRAME) / 1_000)} ms frame in jsdom`,
        `  NOT ASSERTED HERE: the ${String(FRAME_BUDGET_MS)} ms single-frame browser figure — jsdom's own floor already exceeds it`,
        `  decode + QuoteCache + queue (off the rAF path) ${ms(median(rounds.map((r) => r.ingestMs)))} ms per burst`,
        `  React commits across ${String(rounds.length * BURST_FIELD_UPDATES)} field updates: ${String(bed.commits() - commitsBefore)}`,
        '',
      ].join('\n'),
    );

    // WHAT IS ASSERTED, AND WHY IT IS NOT THE 16 ms.
    //
    // The number above is the honest measurement and it is 2-3× the 16 ms one-frame figure. That
    // figure is not asserted here because in jsdom it is not reachable by any implementation: the
    // floor printed above is the cost of the bare DOM writes alone, and at 2 200 cells it is
    // already over 16 ms with no grid code running at all. Asserting it would fail a correct grid
    // for a property of the measuring instrument, and TESTING.md §16 L958 already assigns the
    // browser figure to `packages/e2e/tests/live-grid.spec.ts` and the jsdom figure to the
    // sustained 2 000-cell / 5 000-changes-per-second load — which is the test below, and which
    // passes with margin.
    //
    // What IS asserted is the claim a jsdom test can actually make: the registry costs little more
    // than the DOM writes it must perform. A tick path that went back through React, or that read
    // layout per cell, would be many times the floor rather than a fraction over it.
    // 2.5× is a coarse bound deliberately: the ratio moves with whichever of the two timed loops
    // a GC pause lands in, and a bound tight enough to be interesting would be a bound that flakes.
    // Its precise counterpart is the commit count on the next line, which is an exact zero.
    expect(floorMs).toBeGreaterThan(FRAME_BUDGET_MS);
    expect(overhead).toBeLessThanOrEqual(2.5);

    // ...and that is only possible because React is not on this path.
    expect(bed.commits()).toBe(commitsBefore);
  });

  it('holds 8 ms p95 under 5 000 field changes a second, and does not get slower as it runs', () => {
    const bed = mountBed();
    const commitsBefore = bed.commits();
    const roundP95: number[] = [];
    const allDurations: number[] = [];
    let delivered = 0;
    let generation = 0;

    // Three rounds of the load CLIENT.md §10.6 specifies — 300 frames at 60 Hz, each taking its
    // share of the 25 000 field changes, so the load is sustained 5 000/s rather than one spike an
    // average would hide.
    //
    // THREE IDENTICAL ROUNDS, AND THAT IS THE POINT. The budget is asserted on the first round,
    // which is the design's load measured once. The rounds after it exist to assert something the
    // design assumes without saying: that the fifteenth second of a trading day costs what the
    // fifth did. Three runs of identical work should cost the same; a cost that climbs is state
    // accumulating on the tick path, and that is invisible to any single-round measurement however
    // carefully its p95 is taken.
    for (let round = 0; round < 3; round += 1) {
      const durations: number[] = [];
      for (let frame = 0; frame < SUSTAINED_FRAMES; frame += 1) {
        const target =
          round * SUSTAINED_CHANGES +
          Math.round(((frame + 1) * SUSTAINED_CHANGES) / SUSTAINED_FRAMES);
        while (delivered < target) {
          generation += 1;
          delivered += bed.sweepGeneration(generation, target - delivered);
        }
        const ran = flushFrames(1);
        expect(ran).toHaveLength(1);
        durations.push(ran[0]!);
      }
      expect(durations).toHaveLength(SUSTAINED_FRAMES);
      roundP95.push(percentile(durations, 0.95));
      allDurations.push(...durations);
    }

    expect(delivered).toBeGreaterThanOrEqual(3 * SUSTAINED_CHANGES);
    expect(bed.registry.stats.frames).toBeGreaterThanOrEqual(3 * SUSTAINED_FRAMES);

    const first = roundP95[0]!;
    const last = roundP95.at(-1)!;
    const drift = last / first;
    process.stdout.write(
      [
        `[NFR-02 sustained] ${String(bed.cells)} visible cells, ${String(SUSTAINED_CHANGES_PER_SECOND)} field changes/s for ${String(SUSTAINED_SECONDS)} s × 3 rounds`,
        `  ${String(3 * SUSTAINED_FRAMES)} frames, ${String(delivered)} field changes, ${String(bed.registry.stats.writes)} cell writes`,
        `  rAF p95 per round ${roundP95.map(ms).join(' / ')} ms — budget ${String(SUSTAINED_P95_BUDGET_MS)} ms p95`,
        `  drift round 1 → round 3: ${drift.toFixed(2)}× (identical work, so this should be ~1.00×)`,
        `  mean ${ms(mean(allDurations))} ms · max ${ms(Math.max(...allDurations))} ms · ${(bed.registry.stats.writes / (3 * SUSTAINED_FRAMES)).toFixed(1)} cell writes per frame`,
        `  React commits: ${String(bed.commits() - commitsBefore)}`,
        '',
      ].join('\n'),
    );

    // The budget, on the design's load: NFR-02's 8 ms jsdom p95 (TESTING.md §16 L958). The p95 and
    // only the p95 — a max over 300 frames is whichever frame a garbage collection landed in, which
    // is a property of the machine and not of the grid.
    //
    // EVERY round, not only the first. Asserting the first round alone is what let a listener leak
    // ship: round 1 held 3.0 ms while round 3 was at 8.3 ms, and the only thing that failed was the
    // drift ratio — which a slower round 1 can hide by shrinking it (in a full-suite run the same
    // leak came out at exactly 1.60 against a `<= 1.6` bound). The fifteenth second of a trading day
    // is inside the budget or it is not; there is no reading of NFR-02 under which only the fifth is.
    for (const [round, p95] of roundP95.entries()) {
      expect(p95, `round ${String(round + 1)} p95`).toBeLessThanOrEqual(SUSTAINED_P95_BUDGET_MS);
    }
    expect(first).toBeLessThanOrEqual(SUSTAINED_P95_BUDGET_MS);

    // And the same work, later, must cost the same. 1.6× is loose enough to absorb one contaminated
    // round and far too tight to absorb anything that accumulates: a leak shows up as a ratio that
    // grows with the round number, which a single p95 cannot see at all.
    expect(drift).toBeLessThanOrEqual(1.6);

    expect(bed.commits()).toBe(commitsBefore);
  });

  it('caps the frame rather than dropping: the remainder carries, and carries the newest value', () => {
    // A window wider than the per-frame cap, which is the only way to reach the deferral path at
    // all. This is what keeps the budget from being held by luck: when a burst is bigger than one
    // frame can write, the frame ends on time and the rest goes to the next one.
    viewportPx = TALL_VIEWPORT_PX;
    const bed = mountBed();
    expect(bed.cells).toBeGreaterThan(MAX_WRITES_PER_FRAME);

    const generation = 1;
    const sent = bed.sweepGeneration(generation, Number.POSITIVE_INFINITY);
    expect(sent).toBe(bed.visible.length * LIVE_FIELDS.length);

    const first = flushFrames(1);
    expect(first).toHaveLength(1);
    // The cap held: this frame wrote the cap's worth of cells and stopped, well short of the
    // window. Counted, not asserted as a boolean — "it capped" and "it capped at the right number"
    // are different claims, and only the second one is the cap.
    const cappedWrites = bed.registry.stats.writes;
    expect(cappedWrites).toBeGreaterThanOrEqual(MAX_WRITES_PER_FRAME);
    expect(cappedWrites).toBeLessThan(MAX_WRITES_PER_FRAME + LIVE_FIELDS.length);
    expect(cappedWrites).toBeLessThan(bed.cells);
    // Nothing was dropped: the remainder is still queued and asked for the next frame itself.
    expect(bed.registry.pendingSubjects).toBeGreaterThan(0);
    expect(pendingFrames()).toBe(1);

    // A cell whose write was deferred gets a newer value before the next frame runs. CLIENT.md
    // §10.4: the deferred cell writes the NEWEST number, not the one that was current when it was
    // queued — the value is read from the live `QuoteView` at write time.
    const lastIndex = bed.visible.at(-1)!;
    const lastSubject = `q:${String(lastIndex)}`;
    expect(cellEl(lastSubject, 'PX_LAST').textContent).toBe(
      format('PX_LAST', baseValue(lastIndex, 'PX_LAST'), {}),
    );
    bed.feedGeneration(lastIndex, generation + 1);

    const second = flushFrames(1);
    expect(second).toHaveLength(1);
    // Everything the first frame could not reach was reached by the second: the window is whole.
    expect(bed.registry.stats.writes).toBe(bed.cells);
    expect(bed.registry.pendingSubjects).toBe(0);

    process.stdout.write(
      [
        `[NFR-02 cap] ${String(bed.cells)} visible cells, cap ${String(MAX_WRITES_PER_FRAME)} writes/frame`,
        `  frame 1 ${ms(first[0]!)} ms, ${String(cappedWrites)} writes · frame 2 ${ms(second[0]!)} ms, ${String(bed.registry.stats.writes - cappedWrites)} writes`,
        '',
      ].join('\n'),
    );

    expect(cellEl(lastSubject, 'PX_LAST').textContent).toBe(
      format('PX_LAST', valueAt(lastIndex, 'PX_LAST', generation + 1), {}),
    );
  });
});
