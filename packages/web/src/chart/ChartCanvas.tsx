// packages/web/src/chart/ChartCanvas.tsx — the React half of the chart engine (CLIENT.md §11.1,
// §11.9; CHRT-01..07).
//
// The division of labour is the whole design, and it is the same one `grid/LiveGrid.tsx` states for
// the grid: **React owns the element and the DOM furniture, the `Renderer` owns the pixels.** Two
// stacked canvases, sized to the node with `ResizeObserver` and `devicePixelRatio` (TERM-10), are
// created once; from then on a crosshair move, a pan, a zoom, a streamed forming bar and a drawn
// annotation are imperative calls into `Renderer.setState` / `applyStream` followed by one
// `requestAnimationFrame`. None of them re-renders React. The only things that do are the things a
// person does a few times a minute and that change the DOM: opening the study or overlay picker,
// adding a study, cycling the series type, changing the axis scale, editing an annotation label.
//
// WP-13 shipped the defect this rule exists to prevent — a React repaint wrote the payload's number
// over the live one, and the registry's "no write on a no-op" rule then suppressed the correction, so
// the cell showed a number the cache disagreed with indefinitely. The chart's equivalent would be a
// React commit re-issuing `setSpec` mid-stream: the slot index is rebuilt, the streamed bars are
// gone, and the chart silently rewinds to the payload. So the spec reaches the renderer from exactly
// one place (the spec effect below), the crosshair, viewport, focus, draw mode and pane collapse live
// in a ref rather than in state, and **no attribute is written from both sides**: `data-prov-idx` and
// `data-event-band` are imperative only, and never appear in the JSX below, because an attribute with
// two writers is that defect in miniature.
//
// ## What the DOM is for
//
// A canvas is invisible to the keyboard and to a screen reader, so everything a person must be able
// to reach is real DOM: one focusable host (CLIENT.md §5.4 — a widget is ONE tab stop), a readout
// element the host cites through `aria-describedby`, a legend listing every series with its source,
// a studies list carrying each study's value at the crosshair, the draw-mode footer, and the two
// pickers as ordinary keyboard-operable lists. The readout, the legend values and the study values
// are written with `textContent` from the interaction and tick paths — the same imperative-write
// pattern `grid/cellRegistry.ts` uses and for the same reason — while their structure is React's.
// Each legend value also carries `data-st`, because §12.1 names this legend as one of the four
// surfaces that apply the `ValueState` mapping and a chart may not leave a stale number white.
//
// Where those elements SIT is not decoration either, and it shipped wrong: the two canvases are
// positioned and opaque, so a static sibling is painted underneath one of them. See `HOST_STYLE` and
// the four styles beside it for which of them is visible, which is deliberately clipped, and why.
//
// `data-prov-idx` on the host is not decoration. `Ctrl+I` is a RESERVED key answered by
// `screen/ScreenRenderer.tsx`, which reads the attribute off whatever has focus; provenance on a
// chart is per series (`screen/widgets/registry.ts`), so the attribute has to name the series the
// crosshair is on and change as it moves, or DATA-10 is unmet for every number on the canvas. It is
// therefore written on every crosshair move, in the same call that moves it, and this component
// deliberately does NOT consume `Ctrl+I`: two answers to "which source is this" would drift, and
// `Renderer.focusProvIdx()` is the one answer both paths use.
//
// ## Keyboard, and the one seam that is missing
//
// §11.9's table is implemented in full, and TERM-06 is met by construction: the wheel and the drag
// call `zoomAround` and `panBy`, which are the functions `+`/`-` and `Shift+Arrow` call. There is one
// gap and it is not this file's to close. §11.9 routes `T A N L` and the study list through
// `ScreenCtx.setParams`, and `ChartCanvasProps` (the contract `widgets/Chart.tsx` passes) carries no
// such callback — nothing in `packages/web/src` does yet. The three of those four that are pure
// rendering (series type, normalisation, log scale) are applied here, locally, because the client can
// draw them from the payload it already has. `A` (adjusted prices) is a server-side parameter: it is
// recorded, shown on the host as `data-adjust`, and reported through the optional
// {@link ChartCanvasExtraProps.onParamsChange} so a host that has a `setParams` can persist all four
// — an optional prop, so the component still satisfies `ComponentType<ChartCanvasProps>` and the
// registry contract is unchanged.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react';

import type { FieldId, UpdateEvent, ValueState } from '@terminal/sdk';

import { matchesKey, reservedFor } from '../keyboard/keymap.js';
import type { KeyEventLike } from '../keyboard/keymap.js';
import { useScreenActions } from '../screen/widgets/registry.js';
import type { ChartCanvasProps } from '../screen/widgets/registry.js';
import { COLOUR_TOKENS, readTokens } from '../theme/colours.js';
import type { ColourToken } from '../theme/colours.js';
import { canvasFont, densityMetrics, WEIGHT } from '../theme/type.js';
import { projectAnnotation, serialiseAnnotation } from './annotations.js';
import type { AnnotationScales, AnnotationSlots, ChartAnnotation } from './annotations.js';
import { axisLabel, xLabeller } from './layers.js';
import type { XLabeller } from './layers.js';
import { Renderer } from './renderer.js';
import type { AnnotationPainter } from './renderer.js';
import { defaultParams, studies as STUDY_REGISTRY, studyList } from './studies/index.js';
import { studyNeedsMet } from './studies/needs.js';
import type { StudyId } from './studies/types.js';
import { ChartStream, FORMING_BAR_FIELDS } from './streaming.js';
import { TradingDayIndex } from './tradingDayIndex.js';
import { DRAW_MODES, DRAW_MODE_ANCHORS, DRAW_MODE_LABEL, SERIES_TYPES } from './types.js';
import type {
  ChartFocus,
  ChartFonts,
  ChartSpec,
  ChartTheme,
  DrawMode,
  Hit,
  SeriesType,
  Viewport,
} from './types.js';

/* -------------------------------------------------------------------------------------------- */
/* The live seam                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * How a mounted chart is handed the frames its series are bound to (§11.5, CHRT-02).
 *
 * A port, declared here and injected through context, for the reason `rt/wsBridge.ts` declares
 * `CellRegistryPort`: this component may not import the socket. The bridge fans `UpdateEvent`s out to
 * `grid/cellRegistry.ts` today and the chart is the second consumer of the same fan-out (CLIENT.md
 * §9) — wiring that up belongs to whoever constructs the `WidgetRegistry`, which is the same open
 * item `widgets/Chart.tsx` is waiting on. So the default is "no socket": a chart with no provider
 * draws its payload and never moves, which is the state every screen test runs in and an honest one.
 */
export interface ChartLiveSource {
  /**
   * Subscribe `subjects` for `fields` and receive every update for them; the return value
   * unsubscribes.
   *
   * The subjects and the fields are the ones `ChartSpec.live` names, resolved by
   * `streaming.ts#liveBindings` — the chart does not choose them.
   */
  subscribe(
    subjects: readonly string[],
    fields: readonly FieldId[],
    onUpdate: (e: UpdateEvent) => void,
  ): () => void;

  /**
   * The 1 s staleness sweep, pushed by whoever owns the `QuoteCache` (TERM-12, CLIENT.md §12.1).
   *
   * Optional, and the shape is `rt/wsBridge.ts`'s `restyle(subjects)`: the bridge's sweep already
   * calls `QuoteCache.sweep()` — which recomputes `core/quote/staleness.ts#valueState`, the same
   * function the server's sweep calls — and reports only the subjects whose verdict CHANGED. The
   * chart is handed those verdicts and restyles its legend; it does not own a ticker and does not
   * recompute a verdict, because §12.1 says `st` "is computed by `core/quote/staleness.ts` … and never
   * by a widget", and the parameters it would have to guess (`expectedIntervalMs`, `delayMin`) are the
   * cache's.
   *
   * The returned function stops the subscription. A source that does not implement this ages nothing,
   * which is honest: a chart with no socket draws its payload and never moves.
   */
  onStaleness?(handler: (states: ReadonlyMap<string, ValueState>) => void): () => void;
}

export const ChartLiveContext = createContext<ChartLiveSource | null>(null);

export function useChartLive(): ChartLiveSource | null {
  return useContext(ChartLiveContext);
}

/* -------------------------------------------------------------------------------------------- */
/* Props                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** What `T A N L` and the study picker changed — the `ScreenCtx.setParams` patch of §11.9. */
export interface ChartParamsPatch {
  /** `T`: the primary series' type, cycled through `SERIES_TYPES`. */
  type?: SeriesType;
  /** `A`: whether prices are split/dividend adjusted. Server-side — see the file header. */
  adjust?: boolean;
  /** `N`: `'none' | 'pct' | 'base100'` (CHRT-03 normalisation). */
  normalise?: NonNullable<ChartSpec['yAxes'][number]['normalise']>;
  /** `L`: log scale on the price axis. */
  logScale?: boolean;
  /**
   * `S` (and `V`): the study list, in the shape a screen's own `studies` PARAMETER takes.
   *
   * `{ id, params, pane: 'main' | 'sub' }` and not `ChartSpec.studies`' shape, which is what this used
   * to report and what `GP.params` refuses: a `ChartSpec` study names the pane it draws in by ID
   * (`'RSI'`, because a sub study's pane is its own id, §11.6) while `GpParams.studies[].pane` is the
   * two-value enum `main|sub`, so every study added from the picker sent `ScreenCtx.setParams` a patch
   * the next run request could not validate — the same defect the `T` cycle had with `scatter`, one
   * parameter over. The pane ID is this component's business; what a screen persists is which KIND of
   * pane the study wanted, which is `StudyDef.pane`.
   */
  studies?: { id: string; params: Record<string, number>; pane: 'main' | 'sub' }[];
}

/**
 * The optional half of the props — everything §11 asks for that `ChartCanvasProps` cannot express.
 *
 * All optional, so `ChartCanvas` stays assignable to `ComponentType<ChartCanvasProps>` and
 * `widgets/Chart.tsx` keeps working unchanged; a host that has a `ScreenCtx` passes them.
 */
export interface ChartCanvasExtraProps {
  /** `T A N L` and the study list, for a host that can reach `ScreenCtx.setParams` (§11.9). */
  onParamsChange?: (patch: ChartParamsPatch) => void;
  /** `O`: the security or `<FORMULA(...)>` the overlay picker collected (§11.9, CHRT-07). */
  onOverlayRequest?: (query: string) => void;
  /** `Ctrl+S`: `instrumentId` for `sdk.workspace.annotations.create` (§11.8, API.md §5.7). */
  instrumentId?: number;
  /** The device-pixel ratio, for a caller that wants one that is not the window's (TERM-10). */
  dpr?: number;
}

export type FullChartCanvasProps = ChartCanvasProps & ChartCanvasExtraProps;

/* -------------------------------------------------------------------------------------------- */
/* Theme                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * `tokens.css`'s dark values, duplicated for the one caller that cannot read CSS.
 *
 * A canvas takes a colour string, and an unresolved custom property computes to `''`. Assigning `''`
 * to `fillStyle` is silently ignored — the previous fill stays — so a chart drawn before the
 * stylesheet is in the document would not fail, it would draw everything in whichever colour was set
 * last. That is the worst of the three possible behaviours, so a token that reads empty falls back
 * here. `theme/type.ts` already duplicates the density table for the same reason and carries the same
 * obligation: this table and `theme/tokens.css` must stay in step.
 */
const FALLBACK_COLOURS: Readonly<Record<ColourToken, string>> = Object.freeze({
  '--c-bg': '#000000',
  '--c-bg-panel': '#0a0a0a',
  '--c-bg-header': '#141414',
  '--c-bg-row-alt': '#0e0e0e',
  '--c-bg-selected': '#1c2a3a',
  '--c-value': '#f2f2f2',
  '--c-label': '#ffb000',
  '--c-muted': '#8c8c8c',
  '--c-up': '#37d67a',
  '--c-down': '#ff5252',
  '--c-flat': '#f2f2f2',
  '--c-stale': '#9a9a9a',
  '--c-closed': '#cfcfcf',
  '--c-blocked': '#c48bff',
  '--c-pending': '#6e6e6e',
  '--c-focus': '#4da3ff',
  '--c-error': '#ff5252',
  '--c-warn': '#ffb000',
  '--c-ok': '#37d67a',
  '--c-info': '#4da3ff',
  '--c-grid-line': '#1f1f1f',
  '--c-axis': '#8c8c8c',
  '--c-crosshair': '#ffb000',
  '--c-series-1': '#4da3ff',
  '--c-series-2': '#ffb000',
  '--c-series-3': '#37d67a',
  '--c-series-4': '#ff7ab6',
  '--c-series-5': '#c48bff',
  '--c-series-6': '#ffd166',
  '--flash-up-bg': 'rgba(55, 214, 122, 0.35)',
  '--flash-down-bg': 'rgba(255, 82, 82, 0.35)',
  '--flash-flat-bg': 'rgba(242, 242, 242, 0.18)',
});

/**
 * The palette and the fonts, resolved once per theme or density change (§11.1, §16.1).
 *
 * `getComputedStyle` flushes layout, so it is called here — in an effect — and never inside
 * `frame()`. `digitPx` is MEASURED with `measureText('0')` on the real context rather than assumed
 * from the font size: the axis gutter is "longest label in characters × digitPx", and a guess there
 * is a gutter that clips its own labels on whichever platform substituted a different mono font.
 */
function readChartTheme(
  host: HTMLElement,
  measure: CanvasRenderingContext2D | null,
): { theme: ChartTheme; fonts: ChartFonts } {
  const read = readTokens(host);
  const colour = {} as Record<ColourToken, string>;
  for (const token of COLOUR_TOKENS) {
    const value = read[token];
    colour[token] = value === '' ? FALLBACK_COLOURS[token] : value;
  }
  const root = host.ownerDocument.documentElement;
  const density = densityMetrics(root.dataset.density);
  const axis = canvasFont(density, WEIGHT.body);
  const label = canvasFont(density, WEIGHT.label);
  let digitPx = density.fontPx * 0.6;
  if (measure !== null) {
    const saved = measure.font;
    measure.font = axis;
    const width = measure.measureText('0').width;
    if (Number.isFinite(width) && width > 0) digitPx = width;
    measure.font = saved;
  }
  return {
    theme: { name: root.dataset.theme === 'light' ? 'light' : 'dark', colour },
    fonts: { axis, label, readout: label, lineHeightPx: Math.round(density.fontPx * 1.15), digitPx },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The annotation painter                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** Pixel half-size of a drawn anchor handle — visible, without hiding the bar it sits on. */
const ANCHOR_HANDLE_PX = 3;

/**
 * `annotations.ts`'s geometry, inked (§11.8, CHRT-05).
 *
 * The maths — the seven kinds, the fib ratios, the OLS channel through
 * `core/analytics/stats#olsRegression` — is that module's; what is here is stroke, dash and label,
 * which is the split its own header draws ("the draw preview is `ChartCanvas`'s"). `selected` draws
 * thicker and shows its anchor handles; an annotation with `editable: false` draws dashed, which is
 * §11.8's rule for somebody else's shared line.
 *
 * **The seam is narrower than the geometry needs, and that is reported rather than hidden.**
 * `RendererPlugins.AnnotationPainter` is handed `{ xOfTs, yOfValue }`, while `projectAnnotation`
 * needs an `AnnotationSlots` and the pane's closes INDEXED BY SLOT to fit a `regression_channel`.
 * The renderer owns both and passes neither, so this painter is given them by the component — its own
 * `TradingDayIndex` over the same spec, kept in step across streaming appends. Two indices for one
 * axis is a smell; the fix is an accessor on `Renderer`, which is a sibling's file.
 */
function annotationPainter(
  slots: AnnotationSlots,
  closesBySlot: () => Float64Array | null,
  extendRight: () => boolean,
  theme: ChartTheme,
  fonts: ChartFonts,
): AnnotationPainter {
  return (ctx, pane, map, annotations, selected) => {
    const scales: AnnotationScales = {
      plot: pane.plot,
      x: (slot) => map.xOfTs(slots.tsAt(slot)),
      y: (value) => map.yOfValue(value),
      // Never consulted by `projectAnnotation`: an anchor is placed from a pixel through
      // `Renderer.hitTest`, the only inverse the engine publishes, and the renderer does not hand
      // this painter one. `NaN` is what a caller that reached for it would get, loudly.
      slotAt: () => Number.NaN,
      valueAt: () => Number.NaN,
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.plot.x, pane.plot.y, pane.plot.w, pane.plot.h);
    ctx.clip();
    ctx.font = fonts.label;
    ctx.textBaseline = 'middle';
    annotations.forEach((annotation, index) => {
      const geometry = projectAnnotation(annotation, {
        slots,
        scales,
        closes: closesBySlot(),
        extendRight: extendRight(),
      });
      if (geometry === null) return;
      const chosen = index === selected;
      ctx.strokeStyle = chosen ? theme.colour['--c-focus'] : theme.colour['--c-label'];
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = chosen ? 2 : 1;
      ctx.setLineDash(annotation.editable ? [] : [4, 3]);
      const stroke = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      };
      switch (geometry.kind) {
        case 'trendline':
        case 'hline':
        case 'vline':
          stroke(geometry.line[0], geometry.line[1]);
          break;
        case 'fib':
          for (const level of geometry.levels) {
            stroke({ x: geometry.x0, y: level.y }, { x: geometry.x1, y: level.y });
            ctx.fillText(`${level.ratio.toFixed(1)}%`, geometry.x1 + 2, level.y);
          }
          break;
        case 'regression_channel':
          stroke(geometry.mid[0], geometry.mid[1]);
          ctx.setLineDash([3, 3]);
          stroke(geometry.upper[0], geometry.upper[1]);
          stroke(geometry.lower[0], geometry.lower[1]);
          break;
        case 'rect':
          ctx.strokeRect(geometry.rect.x, geometry.rect.y, geometry.rect.w, geometry.rect.h);
          break;
        case 'text':
          ctx.fillText(geometry.label, geometry.at.x + 4, geometry.at.y);
          break;
      }
      if (!chosen) return;
      ctx.setLineDash([]);
      for (const anchor of annotation.anchors) {
        const x = scales.x(slots.nearestSlot(anchor.t));
        const y = scales.y(anchor.v);
        ctx.fillRect(
          x - ANCHOR_HANDLE_PX,
          y - ANCHOR_HANDLE_PX,
          ANCHOR_HANDLE_PX * 2,
          ANCHOR_HANDLE_PX * 2,
        );
      }
    });
    ctx.restore();
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Keyboard                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * What a keystroke asks the chart to do — §11.9's table, as a value.
 *
 * A pure mapping from a keystroke to an action, separate from the component, for the reason
 * `grid/keyboard.ts` gives: a test that drives a component it also configured proves only that the
 * component agrees with itself. Here the table can be asserted on its own, and the component is one
 * caller of it — the one the acceptance test drives through real DOM events.
 */
export type ChartKeyAction =
  | { kind: 'crosshair'; slots: number }
  | { kind: 'pan'; fraction: number }
  | { kind: 'zoom'; factor: number }
  | { kind: 'jump'; to: 'start' | 'end' }
  | { kind: 'cycle-series'; delta: number }
  | { kind: 'cycle-pane'; delta: number }
  | { kind: 'cycle-type' }
  | { kind: 'toggle-vwap' }
  | { kind: 'toggle-profile' }
  | { kind: 'cycle-adjust' }
  | { kind: 'cycle-normalise' }
  | { kind: 'toggle-log' }
  | { kind: 'picker'; which: 'study' | 'overlay' }
  | { kind: 'toggle-events' }
  | { kind: 'step-event'; delta: 1 | -1 }
  | { kind: 'activate'; nextPanel: boolean }
  | { kind: 'toggle-draw' }
  | { kind: 'draw-kind'; mode: DrawMode }
  | { kind: 'save-annotations' }
  | { kind: 'delete-annotation' }
  | { kind: 'cycle-annotation'; delta: number }
  | { kind: 'move-anchor' }
  | { kind: 'edit-label' }
  | { kind: 'extend-right' }
  | { kind: 'toggle-pane-collapse' }
  | { kind: 'cancel' };

/** How much of the viewport `Shift+Arrow` pans: one tenth (§11.9). */
export const PAN_FRACTION = 0.1;

/** The zoom factor of one `+` / `-` — 25 %, so three presses roughly halve the span. */
export const ZOOM_STEP = 1.25;

/**
 * Draw mode's kind letters (§11.8: "the footer shows `TREND HLINE VLINE FIB TEXT REGR RECT`; the
 * letter picks the kind").
 *
 * Two of the seven initials collide, so two are chosen rather than taken: `T` is TREND, so TEXT is
 * `X`; `R` is REGR, so RECT is `C`. The footer renders the letter beside the label, so the binding is
 * discoverable rather than folklore — the only honest way to ship a disambiguation the document did
 * not make.
 */
export const DRAW_KIND_KEY: Readonly<Record<DrawMode, string>> = Object.freeze({
  trendline: 'T',
  hline: 'H',
  vline: 'V',
  fib: 'F',
  text: 'X',
  regression_channel: 'R',
  rect: 'C',
});

/** What {@link chartKeyAction} needs to know about the chart's current state. */
export interface ChartKeyEnv {
  /** True while `D` is active: the kind letters and `Enter` mean something else (§11.8). */
  readonly drawing: boolean;
  /** True while a picker or the label prompt is open: `Escape` closes it and nothing else applies. */
  readonly modal: boolean;
  /** True when an event marker holds focus: `Enter` runs its command (§11.7). */
  readonly onEvent: boolean;
}

/**
 * §11.9's table, plus §11.7's marker navigation and §11.8's draw mode.
 *
 * `null` means "not ours": the event keeps bubbling and the panel's dispatcher answers. That is how
 * the RESERVED keys stay reserved (`keyboard/keymap.ts`) — `Ctrl+I` above all, which the chart must
 * NOT consume because `ScreenRenderer` answers it from `data-prov-idx` and two answers would drift.
 * `Enter`, `Shift+Enter` and `Escape` are the exceptions, and only when this chart owns something to
 * activate or something to cancel; otherwise they bubble as well, exactly as `grid/keyboard.ts`
 * treats the same two keys.
 */
export function chartKeyAction(e: KeyEventLike, env: ChartKeyEnv): ChartKeyAction | null {
  if (matchesKey(e, 'Escape')) return env.modal || env.drawing ? { kind: 'cancel' } : null;
  if (env.modal) return null;

  // Draw mode's letters come first: while `D` is active `T` is TREND, not "cycle the series type".
  if (env.drawing) {
    if (matchesKey(e, 'Shift+X')) return { kind: 'extend-right' };
    for (const mode of DRAW_MODES) {
      if (matchesKey(e, DRAW_KIND_KEY[mode])) return { kind: 'draw-kind', mode };
    }
    if (matchesKey(e, 'Enter')) return { kind: 'activate', nextPanel: false };
  }

  const reserved = reservedFor(e);
  if (reserved !== null && reserved.action !== 'go' && reserved.action !== 'row-next-panel') {
    return null;
  }

  if (matchesKey(e, 'Ctrl+ArrowLeft')) return { kind: 'step-event', delta: -1 };
  if (matchesKey(e, 'Ctrl+ArrowRight')) return { kind: 'step-event', delta: 1 };
  if (matchesKey(e, 'Shift+ArrowLeft')) return { kind: 'pan', fraction: -PAN_FRACTION };
  if (matchesKey(e, 'Shift+ArrowRight')) return { kind: 'pan', fraction: PAN_FRACTION };
  if (matchesKey(e, 'ArrowLeft')) return { kind: 'crosshair', slots: -1 };
  if (matchesKey(e, 'ArrowRight')) return { kind: 'crosshair', slots: 1 };
  if (matchesKey(e, 'Alt+ArrowUp')) return { kind: 'cycle-pane', delta: -1 };
  if (matchesKey(e, 'Alt+ArrowDown')) return { kind: 'cycle-pane', delta: 1 };
  if (matchesKey(e, 'ArrowUp')) {
    return env.drawing
      ? { kind: 'cycle-annotation', delta: -1 }
      : { kind: 'cycle-series', delta: -1 };
  }
  if (matchesKey(e, 'ArrowDown')) {
    return env.drawing ? { kind: 'cycle-annotation', delta: 1 } : { kind: 'cycle-series', delta: 1 };
  }
  // The two zoom keys are matched by hand, and `matchesKey` is the reason. Its modifier rule is exact
  // — `'G'` is deliberately not fired by `Shift+G` — and `+` is `Shift+Equal` on a US layout, so
  // `matchesKey(e, '+')` cannot fire for the keystroke a trader actually makes: the event arrives with
  // `key: '+'` AND `shiftKey: true`, and no spec string spells that ("Shift++" does not parse). So
  // zoom accepts either half of the physical key, shifted or not, on the letter-free layouts too.
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
  if (plain && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) {
    return { kind: 'zoom', factor: ZOOM_STEP };
  }
  if (plain && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) {
    return { kind: 'zoom', factor: 1 / ZOOM_STEP };
  }
  if (matchesKey(e, 'Home')) return { kind: 'jump', to: 'start' };
  if (matchesKey(e, 'End')) return { kind: 'jump', to: 'end' };
  if (matchesKey(e, 'Ctrl+S')) return { kind: 'save-annotations' };
  if (matchesKey(e, 'Delete') || matchesKey(e, 'Backspace')) return { kind: 'delete-annotation' };
  if (matchesKey(e, 'Space')) return { kind: 'toggle-pane-collapse' };
  if (matchesKey(e, 'Shift+Enter')) return { kind: 'activate', nextPanel: true };
  if (matchesKey(e, 'Enter')) return env.onEvent ? { kind: 'activate', nextPanel: false } : null;
  if (matchesKey(e, 'T')) return { kind: 'cycle-type' };
  if (matchesKey(e, 'A')) return { kind: 'cycle-adjust' };
  if (matchesKey(e, 'N')) return { kind: 'cycle-normalise' };
  if (matchesKey(e, 'L')) return env.drawing ? { kind: 'edit-label' } : { kind: 'toggle-log' };
  if (matchesKey(e, 'M')) return { kind: 'move-anchor' };
  if (matchesKey(e, 'S')) return { kind: 'picker', which: 'study' };
  if (matchesKey(e, 'O')) return { kind: 'picker', which: 'overlay' };
  if (matchesKey(e, 'E')) return { kind: 'toggle-events' };
  if (matchesKey(e, 'D')) return { kind: 'toggle-draw' };
  // §11.9's last row: "`V` (GIP) toggle VWAP; `P` (GIP) profile view". Both were unreachable from any
  // key — `V` existed only as draw mode's VLINE letter (handled above, while `env.drawing`) and `P`
  // was in neither this table nor GIP's manifest keymap, so the profile toggle §11.9 names could not
  // be performed at all, which is a TERM-06 gap ("every action above is the same function the key
  // calls"). They are answered here, and the component refuses each one on a chart whose data cannot
  // support it rather than this table guessing at the screen.
  if (matchesKey(e, 'V')) return { kind: 'toggle-vwap' };
  if (matchesKey(e, 'P')) return { kind: 'toggle-profile' };
  return null;
}

/* -------------------------------------------------------------------------------------------- */
/* Imperative state                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * Everything a keystroke changes that React does not render.
 *
 * In a ref, not in state, and that is the no-re-render rule in one declaration: the renderer reads
 * these, the DOM shows them through two `textContent` writes and one attribute, and a commit per
 * arrow key or per streamed bar would reconcile a tree that cannot have changed.
 */
interface ChartUiState {
  view: Viewport;
  crosshairSlot: number | null;
  seriesIndex: number;
  paneIndex: number;
  focus: ChartFocus;
  drawMode: DrawMode | null;
  /** Anchors placed so far in draw mode, short of the kind's count (§11.8). */
  pending: { t: number; v: number }[];
  selected: number | null;
  eventIndex: number | null;
  eventBand: boolean;
  collapsed: Set<string>;
  movingAnchor: boolean;
  extendRight: boolean;
  drag: { x: number; slot0: number; slot1: number } | null;
}

/**
 * `ChartSpec.studies` → the patch shape a screen's `studies` parameter takes (see
 * {@link ChartParamsPatch.studies}).
 *
 * The pane kind comes from the REGISTRY rather than from the entry, because that is where it is
 * declared: §11.6 fixes `pane: 'main' | 'sub'` per study, and a `ChartSpec` entry's `pane` is the
 * resolved pane id that follows from it.
 */
function studiesPatch(
  entries: readonly NonNullable<ChartSpec['studies']>[number][],
): { id: string; params: Record<string, number>; pane: 'main' | 'sub' }[] {
  return entries.map((entry) => ({
    id: entry.id,
    params: entry.params,
    pane: STUDY_REGISTRY[entry.id as StudyId]?.pane ?? 'sub',
  }));
}

/**
 * The series types `T` may cycle to for this spec, in §11.3's order (§11.9).
 *
 * `T` used to walk the whole twelve-member `SERIES_TYPES` union on every chart, and two things came
 * of it. It reported `{ type: 'scatter' }` through `onParamsChange` — a value `GpChartType` does not
 * contain, so one of the twelve presses handed `ScreenCtx.setParams` a patch the next run request
 * could not validate. And it drew pictures the rest of the chart contradicted: `profile` bucketed
 * 30-minute TPO periods out of ELEVEN DAILY bars (§11.3 ships it "for GIP `TYPE=PROFILE` on 1-/5-day
 * ranges only"), while `heatmap` colour-ramped cells by `volume` under a y axis still labelled in
 * prices and a legend still reading the close.
 *
 * So the cycle is what the series can actually supply:
 *
 *   * `candle` / `ohlc` need the bar, and `profile` needs it AND an intraday spec;
 *   * `heatmap` is `category × category` with the value in `volume` (§11.3), which a price spec is not;
 *   * `scatter` is never cycled TO. It is an authored mark — an option smile, an event study — chosen
 *     because the data is points, and no screen manifest offers it as a type.
 *
 * A spec whose own type is outside this list is left alone by `T` (see `cycleType`).
 */
export function cyclableTypes(spec: ChartSpec): SeriesType[] {
  const series = spec.series[0];
  const hasOhlc = series?.ohlc !== undefined;
  const hasVolume = series?.volume !== undefined;
  const categorical = spec.xAxis.type === 'category';
  return SERIES_TYPES.filter((type) => {
    if (type === 'scatter') return false;
    if (type === 'candle' || type === 'ohlc') return hasOhlc;
    if (type === 'profile') return hasOhlc && spec.kind === 'intraday';
    if (type === 'heatmap') return hasVolume && categorical;
    return true;
  });
}

/** The three axis options `N` cycles (CHRT-03). */
const NORMALISE_CYCLE: readonly NonNullable<ChartSpec['yAxes'][number]['normalise']>[] =
  Object.freeze(['none', 'pct', 'base100']);

/** A fresh chart shows every slot: a spec arrives with the range it wants (`ChartSpec.range`). */
function fullView(spec: ChartSpec): Viewport {
  let n = 0;
  for (const series of spec.series) n = Math.max(n, Math.min(series.x.length, series.y.length));
  return { slot0: 0, slot1: Math.max(0, n - 1) };
}

/**
 * One pane's closes, indexed BY SLOT — what `regression_channel` is fitted over (§11.8).
 *
 * Built through the index's own per-series slot table rather than by assuming slot `i` is point `i`.
 * The assumption holds for a single-series chart and fails for an overlay on another calendar, which
 * is the case `annotations.ts` warns index-by-slot cannot express: a channel fitted over a
 * mis-indexed close column is a channel through the wrong prices, and it would look plausible.
 */
function closesBySlotOf(spec: ChartSpec, index: TradingDayIndex): Float64Array | null {
  const series = spec.series[0];
  if (series === undefined || index.length === 0) return null;
  const source = series.ohlc?.c ?? series.y;
  const out = new Float64Array(index.length);
  out.fill(Number.NaN);
  for (let slot = 0; slot < index.length; slot += 1) {
    // `TradingDayIndex.indexAt` answers `GAP` (-1) for a slot this series has no point at.
    const at = index.indexAt(series.id, slot);
    if (at < 0) continue;
    out[slot] = source[at] ?? Number.NaN;
  }
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* Where the DOM furniture sits (§11.1, §11.8)                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * The stacking, inline, and why every one of these is load-bearing.
 *
 * `widgets.css` and `theme/tokens.css` carry no `.chart` rule, and this package has ONE stylesheet
 * entry point (`main.tsx`, which is not this work package's file), so the geometry that decides
 * whether a person can see the picker they are typing into cannot be left to a stylesheet that does
 * not exist. It shipped wrong: both canvases are `position:absolute; inset:0` inside a
 * `position:relative` host and the base is opaque (`alpha: false`, repainted every frame), while the
 * readout, the legend, the studies list, the draw-mode footer and the picker were static in-flow
 * siblings — and CSS 2.1 painting order puts positioned descendants above non-positioned ones. So the
 * opaque canvas covered all five, including a search field with `autoFocus`. Every test passed
 * because jsdom does not lay out and each one asserted `textContent`.
 *
 * Two answers, because the five elements are not all the same thing:
 *
 *   * the readout, the legend and the studies list are drawn ON the canvas by the renderer (§11.1
 *     lists the legend among the base canvas's contents), so their DOM copies exist for the keyboard
 *     and the screen reader. They are therefore hidden the deliberate way — clipped to a pixel, never
 *     `display:none`, which would take them out of the accessibility tree and out of
 *     `aria-describedby` with them.
 *   * the picker and the draw-mode footer have NO canvas copy and the picker takes focus, so they are
 *     positioned above the canvases and visible.
 */
const HOST_STYLE: CSSProperties = { position: 'relative', width: '100%', height: '100%' };
const CANVAS_STYLE: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

/** Visually hidden, still focusable and still read aloud — the canvas holds the visible copy. */
const SR_ONLY_STYLE: CSSProperties = Object.freeze({
  position: 'absolute',
  width: 1,
  height: 1,
  margin: 0,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
});

/** Above both canvases: the only two pieces of furniture with no canvas copy (§11.8's footer, `S`). */
const OVER_CANVAS_STYLE: CSSProperties = Object.freeze({
  position: 'absolute',
  zIndex: 2,
  margin: 0,
});

/** The draw-mode footer sits along the bottom edge; the picker opens over the top-left of the plot. */
const FOOTER_STYLE: CSSProperties = Object.freeze({ ...OVER_CANVAS_STYLE, left: 0, right: 0, bottom: 0 });
const PICKER_STYLE: CSSProperties = Object.freeze({ ...OVER_CANVAS_STYLE, left: 8, top: 8 });

/* -------------------------------------------------------------------------------------------- */
/* The component                                                                                  */
/* -------------------------------------------------------------------------------------------- */

export function ChartCanvas({
  id,
  spec,
  onEvent,
  onParamsChange,
  onOverlayRequest,
  instrumentId,
  dpr: dprProp,
}: FullChartCanvasProps): ReactElement {
  const actions = useScreenActions();
  const live = useChartLive();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const readoutRef = useRef<HTMLParagraphElement | null>(null);
  const legendRef = useRef<HTMLUListElement | null>(null);
  const studiesRef = useRef<HTMLUListElement | null>(null);
  /**
   * The last `ValueState` each live series was told about (TERM-12, CLIENT.md §12.1).
   *
   * Keyed by series id and not by subject, because that is what the legend is keyed by; a series with
   * no entry has had no frame, and its legend value carries NO `data-st` rather than a guess. The
   * payload's own freshness is not knowable here — `ChartSeries` carries no `st` and the payload's
   * `meta.staleness` does not reach a widget — and claiming `live` for it is the one answer that would
   * repeat the defect this exists to close.
   */
  const stateRef = useRef(new Map<string, ValueState>());
  /** How a slot is labelled on this spec's x axis (`layers.ts#xLabeller`), rebuilt with the spec. */
  const xLabelRef = useRef<XLabeller>(xLabeller(spec, Number.NaN, Number.NaN));
  const rendererRef = useRef<Renderer | null>(null);
  const frameRef = useRef<number | null>(null);
  /** Frames to queue behind the next one — see {@link schedule}. */
  const chaseRef = useRef(0);

  // ── React state: only what changes the DOM ────────────────────────────────────────────────
  const [picker, setPicker] = useState<'study' | 'overlay' | 'label' | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [drawing, setDrawing] = useState<DrawMode | null>(null);
  const [options, setOptions] = useState<{
    type: SeriesType | null;
    adjust: boolean;
    normalise: NonNullable<ChartSpec['yAxes'][number]['normalise']> | null;
    log: boolean | null;
  }>({ type: null, adjust: true, normalise: null, log: null });

  /**
   * The study list and the annotations, as edited HERE — `null` until a key edits one.
   *
   * `null` rather than a copy of the spec's, because the payload has to be able to win. A screen
   * hands down a new `ChartSpec` whenever it re-runs, and a local copy seeded once at mount would
   * then draw last hour's studies over this hour's prices — the same shape of defect as WP-13's
   * React-over-live cell, arriving from the other direction. So the spec is the value until the user
   * touches it, and a new spec resets the edit (the effect below), which is honest for both: an
   * annotation the user drew and did not save with `Ctrl+S` is not persisted state.
   */
  const [editedStudies, setEditedStudies] = useState<NonNullable<ChartSpec['studies']> | null>(null);
  const [editedAnnotations, setEditedAnnotations] = useState<ChartAnnotation[] | null>(null);

  const specStudies = spec.studies;
  const specAnnotations = spec.annotations;
  useEffect(() => {
    setEditedStudies(null);
  }, [specStudies]);
  useEffect(() => {
    setEditedAnnotations(null);
  }, [specAnnotations]);

  const studiesNow = editedStudies ?? specStudies ?? [];
  const annotationsNow = editedAnnotations ?? specAnnotations ?? [];
  const annotationsRef = useRef<readonly ChartAnnotation[]>(annotationsNow);
  annotationsRef.current = annotationsNow;
  /** What the imperative furniture writer reads — the same list the JSX rendered this commit. */
  const studiesNowRef = useRef<readonly NonNullable<ChartSpec['studies']>[number][]>(studiesNow);
  studiesNowRef.current = studiesNow;

  /** Edit the annotation list from an imperative handler, off the ref rather than off a closure. */
  const mutateAnnotations = useCallback(
    (fn: (list: ChartAnnotation[]) => ChartAnnotation[]): void => {
      setEditedAnnotations(fn([...annotationsRef.current]));
    },
    [],
  );

  /**
   * The spec the renderer draws, with the local options applied (§11.9 `T A N L`, `S`).
   *
   * Derived rather than mutated: `ChartSpec` comes from the payload, so an option has to be a
   * transform of whatever arrived rather than an edit of the object that did. `A` is absent on
   * purpose — adjusted prices are a server-side series, and the client has one, not two.
   */
  const drawnSpec = useMemo<ChartSpec>(() => {
    const priceAxis = spec.yAxes[0]?.id;
    const typeOverride = options.type;
    const series =
      typeOverride === null
        ? spec.series
        : spec.series.map((s, i) => (i === 0 ? { ...s, type: typeOverride } : s));
    const yAxes = spec.yAxes.map((axis) => {
      if (axis.id !== priceAxis) return axis;
      const next = { ...axis };
      if (options.log !== null) next.scale = options.log ? 'log' : 'linear';
      if (options.normalise !== null) next.normalise = options.normalise;
      return next;
    });
    const panes = [...spec.panes];
    for (const study of studiesNow) {
      if (study.pane !== 'main' && !panes.some((pane) => pane.id === study.pane)) {
        // §11.6: a `sub` study adds a pane of its own at 0.18 of the plot and the main pane shrinks.
        // `layers.ts#computeLayout` normalises the fractions, so adding the pane is the whole of it.
        panes.push({ id: study.pane, height: 0.18, title: study.id });
      }
    }
    return {
      ...spec,
      series,
      yAxes,
      panes,
      ...(studiesNow.length === 0 ? {} : { studies: studiesNow }),
      ...(annotationsNow.length === 0 ? {} : { annotations: annotationsNow }),
    };
  }, [spec, options, studiesNow, annotationsNow]);

  /**
   * The slot axis this component reads for annotation anchors, beside the renderer's own.
   *
   * The renderer publishes no slot → timestamp accessor, so an anchor placed by the keyboard — which
   * needs the instant of the crosshair's slot — has nowhere to read one. This is the same mapping
   * over the same spec, and it is advanced by the same appends (the stream effect appends here on the
   * condition the renderer appends there), so the two cannot drift apart while a chart streams.
   */
  const indexRef = useRef<TradingDayIndex>(TradingDayIndex.fromSpec(drawnSpec));
  const closesRef = useRef<Float64Array | null>(null);

  const uiRef = useRef<ChartUiState>({
    view: fullView(spec),
    crosshairSlot: null,
    seriesIndex: 0,
    paneIndex: 0,
    focus: { kind: 'plot' },
    drawMode: null,
    pending: [],
    selected: null,
    eventIndex: null,
    eventBand: true,
    collapsed: new Set<string>(),
    movingAnchor: false,
    extendRight: false,
    drag: null,
  });

  /** What the imperative handlers read — never `drawnSpec` through a closure, which goes stale. */
  const specRef = useRef(drawnSpec);
  specRef.current = drawnSpec;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  /* ── the frame pump ──────────────────────────────────────────────────────────────────────── */

  /**
   * Ask for a frame, at most one outstanding (§11.1).
   *
   * `chase` exists for §11.5's rate-limited full redraw: `Renderer.frame` defers a redraw caused by a
   * value leaving the axis range to at most once a second, and if nothing asks for a later frame that
   * redraw never happens — the chart would sit with a line drawn outside its own axis until the next
   * tick, which on a quiet subject is minutes. A streamed patch therefore asks for a frame and leaves
   * one queued behind it.
   */
  const schedule = useCallback((chase = 0): void => {
    chaseRef.current = Math.max(chaseRef.current, chase);
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame((now) => {
      frameRef.current = null;
      rendererRef.current?.frame(now);
      if (chaseRef.current > 0) {
        chaseRef.current -= 1;
        schedule();
      }
    });
  }, []);

  /* ── the readout, the legend and `data-prov-idx` ─────────────────────────────────────────── */

  /**
   * Write the crosshair readout, the legend values and `data-prov-idx` (DATA-10, §11.9).
   *
   * Imperative `textContent` in the same call that moved the crosshair, for the reason
   * `grid/cellRegistry.ts` writes cells imperatively: this runs on the interaction path and on the
   * tick path, and reconciliation there buys nothing — the structure cannot have changed, only three
   * strings and one attribute.
   */
  const paintFurniture = useCallback((): void => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (renderer === null || host === null) return;
    const ui = uiRef.current;
    const current = specRef.current;

    host.dataset.provIdx = String(renderer.focusProvIdx());
    // The viewport, as the one thing about the drawn state that is not visible in the readout. It is
    // here because it has two readers who cannot ask the canvas: a workspace save, which persists
    // where a panel was looking (TERM-05), and a test, which in jsdom has no pixels to measure
    // (TESTING.md §2.2). Imperative like everything else on this element, and never in the JSX.
    host.dataset.view = `${ui.view.slot0.toFixed(2)}:${ui.view.slot1.toFixed(2)}`;

    const slot = ui.crosshairSlot;
    const legend = legendRef.current;
    if (legend !== null) {
      for (const series of current.series) {
        const cell = legend.querySelector<HTMLElement>(`[data-value-of="${series.id}"]`);
        if (cell === null) continue;
        const axis = current.yAxes.find((a) => a.id === series.yAxis);
        const value = slot === null ? Number.NaN : renderer.valueOfSeriesAtSlot(series.id, slot);
        cell.textContent = Number.isFinite(value)
          ? axisLabel(axis?.fmt ?? 'px', value, axis?.decimals)
          : '—';
        // CLIENT.md §12.1 names the chart legend as one of the four surfaces that apply the
        // `ValueState` mapping, and it applied none: `st` was computed off every frame and dropped,
        // so a chart went on showing a stale or resyncing number in the live colour — WP-13's shipped
        // blocker, one surface over. The verdict comes from the frame (`streaming.ts#LiveUpdate.st`)
        // and from the 1 s sweep, and is written here because this is the call that writes the value.
        const st = stateRef.current.get(series.id);
        if (st === undefined) cell.removeAttribute('data-st');
        else cell.setAttribute('data-st', st);
      }
    }

    const studyRows = slot === null ? [] : renderer.studyRowsAt(slot);
    const studiesList = studiesRef.current;
    if (studiesList !== null) {
      for (const study of studiesNowRef.current) {
        const cell = studiesList.querySelector<HTMLElement>(`[data-value-of-study="${study.id}"]`);
        if (cell === null) continue;
        const mine = studyRows.filter((row) => row.studyId === study.id);
        const skipped = renderer
          .skippedStudies()
          .find((entry) => entry.id === study.id);
        cell.textContent =
          skipped !== undefined
            ? `not available — needs ${skipped.needs.join(' and ')}`
            : mine.map((row) => `${row.label} ${row.text}`).join(' · ');
      }
    }

    const readout = readoutRef.current;
    if (readout === null) return;
    if (slot === null) {
      readout.textContent = 'No crosshair. Left and right arrows move it.';
      return;
    }
    const ts = indexRef.current.valueAt(slot);
    const parts = current.series.map((series) => {
      const axis = current.yAxes.find((a) => a.id === series.yAxis);
      const value = renderer.valueOfSeriesAtSlot(series.id, slot);
      const text = Number.isFinite(value)
        ? axisLabel(axis?.fmt ?? 'px', value, axis?.decimals)
        : '—';
      return `${series.label} ${text}`;
    });
    // Every study line too (§11.9's first row: "every series/**study** value at the slot"). A sub
    // pane's whole purpose is the number in it, and it existed only as pixels on an `aria-hidden`
    // canvas.
    for (const row of studyRows) parts.push(`${row.label} ${row.text}`);
    // The x label through `layers.ts#xLabeller`, which is the same answer the canvas readout and the
    // axis strip use. `new Date(ts).toISOString()` was wrong on four of the six real screens: on a
    // `tenor` axis `ts` is a DAY COUNT, on OMON a STRIKE and on OVML a SPOT PRICE, so CRVF announced
    // `1970-01-01T00:00:01.826Z` at its 5Y node.
    const when = Number.isFinite(ts) ? xLabelRef.current(slot, ts) : `slot ${String(slot)}`;
    readout.textContent = `${when} · ${parts.join(' · ')}`;
  }, []);

  /* ── the shared actions: each of these is what a key AND the mouse call (TERM-06) ─────────── */

  const commit = useCallback(
    (patch: { view?: Viewport; crosshair?: boolean; focus?: boolean }): void => {
      const renderer = rendererRef.current;
      if (renderer === null) return;
      const ui = uiRef.current;
      if (patch.view !== undefined) {
        ui.view = patch.view;
        renderer.setState({ view: patch.view });
      }
      if (patch.crosshair === true) {
        const seriesId = specRef.current.series[ui.seriesIndex]?.id ?? null;
        renderer.setState({
          crosshair:
            ui.crosshairSlot === null || seriesId === null
              ? null
              : { slot: ui.crosshairSlot, seriesId },
        });
      }
      if (patch.focus === true) renderer.setState({ focus: ui.focus });
      paintFurniture();
      schedule();
    },
    [paintFurniture, schedule],
  );

  const lastSlot = useCallback((): number => Math.max(0, indexRef.current.length - 1), []);

  const setCrosshairSlot = useCallback(
    (slot: number | null): void => {
      const ui = uiRef.current;
      ui.crosshairSlot = slot === null ? null : Math.min(Math.max(0, Math.round(slot)), lastSlot());
      const at = ui.crosshairSlot;
      if (ui.movingAnchor && ui.selected !== null && at !== null) {
        // `M`: the selected annotation's last anchor follows the crosshair (§11.8). The value is kept
        // and only the instant moves, because the crosshair carries a slot, not a price.
        const target = ui.selected;
        mutateAnnotations((list) =>
          list.map((annotation, index) => {
            if (index !== target || annotation.anchors.length === 0) return annotation;
            const anchors = [...annotation.anchors];
            const end = anchors.length - 1;
            const previous = anchors[end];
            if (previous === undefined) return annotation;
            anchors[end] = { t: indexRef.current.valueAt(at), v: previous.v };
            return { ...annotation, anchors };
          }),
        );
      }
      commit({ crosshair: true });
    },
    [commit, lastSlot, mutateAnnotations],
  );

  const moveCrosshair = useCallback(
    (slots: number): void => {
      const ui = uiRef.current;
      const from = ui.crosshairSlot ?? Math.round(ui.view.slot1);
      setCrosshairSlot(from + slots);
    },
    [setCrosshairSlot],
  );

  const panBy = useCallback(
    (fraction: number): void => {
      const ui = uiRef.current;
      const span = ui.view.slot1 - ui.view.slot0;
      const last = lastSlot();
      let slot0 = ui.view.slot0 + span * fraction;
      let slot1 = ui.view.slot1 + span * fraction;
      // Clamped by TRANSLATION, not by clipping each edge: clipping one edge at a boundary would
      // shrink the span, so panning into the left edge and back out would leave the user zoomed in.
      if (slot0 < 0) {
        slot1 -= slot0;
        slot0 = 0;
      }
      if (slot1 > last) {
        slot0 -= slot1 - last;
        slot1 = last;
      }
      commit({ view: { slot0: Math.max(0, slot0), slot1: Math.min(last, slot1) } });
    },
    [commit, lastSlot],
  );

  const zoomAround = useCallback(
    (factor: number, anchorSlot?: number): void => {
      const ui = uiRef.current;
      const last = lastSlot();
      const anchor = anchorSlot ?? ui.crosshairSlot ?? ui.view.slot1;
      const span = Math.max(1, ui.view.slot1 - ui.view.slot0);
      const next = Math.max(1, Math.min(last, span / factor));
      const share = (anchor - ui.view.slot0) / span;
      const slot0 = Math.max(0, Math.min(Math.max(0, last - next), anchor - share * next));
      commit({ view: { slot0, slot1: Math.min(last, slot0 + next) } });
    },
    [commit, lastSlot],
  );

  /**
   * `Home` / `End` (§11.9). `End` re-enables auto-follow, and by definition rather than by a flag:
   * the renderer's follow rule is "the viewport's right edge is the last slot" (§11.5), so putting the
   * right edge back on the last slot is what turns following back on.
   */
  const jumpTo = useCallback(
    (to: 'start' | 'end'): void => {
      const ui = uiRef.current;
      const last = lastSlot();
      const span = ui.view.slot1 - ui.view.slot0;
      const view =
        to === 'start'
          ? { slot0: 0, slot1: Math.min(last, span) }
          : { slot0: Math.max(0, last - span), slot1: last };
      ui.crosshairSlot = to === 'start' ? 0 : last;
      commit({ view, crosshair: true });
    },
    [commit, lastSlot],
  );

  const cycleSeries = useCallback(
    (delta: number): void => {
      const ui = uiRef.current;
      const count = specRef.current.series.length;
      if (count === 0) return;
      ui.seriesIndex = (ui.seriesIndex + delta + count) % count;
      const series = specRef.current.series[ui.seriesIndex];
      if (series !== undefined) ui.focus = { kind: 'legend', seriesId: series.id };
      // A crosshair is what makes a series the focused one, so cycling with none lands on the right
      // edge rather than doing nothing visible.
      ui.crosshairSlot ??= Math.round(ui.view.slot1);
      commit({ crosshair: true, focus: true });
    },
    [commit],
  );

  const cyclePane = useCallback(
    (delta: number): void => {
      const ui = uiRef.current;
      const panes = specRef.current.panes;
      if (panes.length === 0) return;
      ui.paneIndex = (ui.paneIndex + delta + panes.length) % panes.length;
      const pane = panes[ui.paneIndex];
      if (pane !== undefined) ui.focus = { kind: 'pane', paneId: pane.id };
      commit({ focus: true });
    },
    [commit],
  );

  const togglePaneCollapse = useCallback((): void => {
    const renderer = rendererRef.current;
    const ui = uiRef.current;
    const pane = specRef.current.panes[ui.paneIndex];
    // The price pane is not collapsible: §11.9's `Space` collapses "a sub pane", and a chart with no
    // price on it is not a state a key should be able to reach.
    if (renderer === null || pane === undefined || pane.id === specRef.current.panes[0]?.id) return;
    const next = new Set(ui.collapsed);
    if (next.has(pane.id)) next.delete(pane.id);
    else next.add(pane.id);
    ui.collapsed = next;
    renderer.setState({ collapsedPanes: next });
    // Same reason as `data-view`: a collapsed pane is persisted layout and is invisible to a test that
    // cannot measure the canvas. Imperative only.
    hostRef.current?.setAttribute('data-collapsed', [...next].join(','));
    schedule();
  }, [schedule]);

  const toggleEventBand = useCallback((): void => {
    const ui = uiRef.current;
    ui.eventBand = !ui.eventBand;
    rendererRef.current?.setEventBandVisible(ui.eventBand);
    // Imperative, and NOT in the JSX: an attribute written from both React and here is the
    // two-writers defect this component is built to avoid.
    hostRef.current?.setAttribute('data-event-band', ui.eventBand ? 'on' : 'off');
    schedule();
  }, [schedule]);

  /**
   * `Ctrl+ArrowLeft/Right` — the previous/next event marker, the crosshair following (§11.7).
   *
   * Over `ChartSpec.events` in slot order rather than over `events.ts#layoutEventMarkers`' placed
   * markers, because placement needs pane geometry and this is a data step: an event outside the
   * viewport is still the next event, and stepping to it brings the view with it.
   */
  const stepEvent = useCallback(
    (delta: 1 | -1): void => {
      const events = specRef.current.events ?? [];
      if (events.length === 0) return;
      const ui = uiRef.current;
      const order = events
        .map((event, index) => ({ index, slot: indexRef.current.nearestSlot(event.t) }))
        .sort((a, b) => a.slot - b.slot);
      const at = ui.eventIndex === null ? -1 : order.findIndex((e) => e.index === ui.eventIndex);
      const next =
        at === -1 ? (delta === 1 ? order[0] : order[order.length - 1]) : order[at + delta];
      if (next === undefined) return;
      ui.eventIndex = next.index;
      ui.focus = { kind: 'event', index: next.index };
      ui.crosshairSlot = next.slot;
      if (next.slot < ui.view.slot0 || next.slot > ui.view.slot1) {
        const span = ui.view.slot1 - ui.view.slot0;
        const slot0 = Math.max(0, Math.min(Math.max(0, lastSlot() - span), next.slot - span / 2));
        commit({
          view: { slot0, slot1: Math.min(lastSlot(), slot0 + span) },
          crosshair: true,
          focus: true,
        });
        return;
      }
      commit({ crosshair: true, focus: true });
    },
    [commit, lastSlot],
  );

  /* ── draw mode (§11.8, CHRT-05) ──────────────────────────────────────────────────────────── */

  const setDrawMode = useCallback(
    (mode: DrawMode | null): void => {
      const ui = uiRef.current;
      ui.drawMode = mode;
      ui.pending = [];
      if (mode === null) ui.movingAnchor = false;
      rendererRef.current?.setState({ drawMode: mode });
      // One commit, so the footer appears or goes: the hints are DOM because a footer drawn on the
      // canvas is a footer no screen reader can read (§5.4).
      setDrawing(mode);
      schedule();
    },
    [schedule],
  );

  const cancelDraw = useCallback((): void => {
    setPicker(null);
    setPickerQuery('');
    setDrawMode(null);
  }, [setDrawMode]);

  /**
   * `Enter` in draw mode places an anchor at the crosshair; the last one completes the shape (§11.8).
   *
   * The instant comes from the slot index, so a placed anchor is always the instant of a real bar and
   * the round trip through `chart_annotations.anchors` is exact — `annotations.ts#anchorAt` states why
   * the slot is rounded and the value is not, and this is the keyboard's half of the same rule (the
   * pixel half is `Renderer.hitTest`).
   */
  const placeAnchor = useCallback((): void => {
    const ui = uiRef.current;
    const renderer = rendererRef.current;
    const mode = ui.drawMode;
    if (renderer === null || mode === null || ui.crosshairSlot === null) return;
    const series = specRef.current.series[ui.seriesIndex];
    const value =
      series === undefined ? Number.NaN : renderer.valueOfSeriesAtSlot(series.id, ui.crosshairSlot);
    const anchor = {
      t: indexRef.current.valueAt(ui.crosshairSlot),
      v: Number.isFinite(value) ? value : 0,
    };
    const pending = [...ui.pending, anchor];
    if (pending.length < DRAW_MODE_ANCHORS[mode]) {
      ui.pending = pending;
      schedule();
      return;
    }
    ui.pending = [];
    ui.selected = annotationsRef.current.length;
    rendererRef.current?.setSelectedAnnotation(ui.selected);
    mutateAnnotations((list) => [
      ...list,
      { annotationId: null, kind: mode, anchors: pending, editable: true },
    ]);
  }, [mutateAnnotations, schedule]);

  const cycleAnnotation = useCallback(
    (delta: number): void => {
      const ui = uiRef.current;
      const count = annotationsRef.current.length;
      if (count === 0) return;
      ui.selected = ui.selected === null ? 0 : (ui.selected + delta + count) % count;
      rendererRef.current?.setSelectedAnnotation(ui.selected);
      schedule();
    },
    [schedule],
  );

  const deleteAnnotation = useCallback((): void => {
    const ui = uiRef.current;
    const at = ui.selected;
    if (at === null) return;
    ui.selected = null;
    ui.movingAnchor = false;
    rendererRef.current?.setSelectedAnnotation(null);
    mutateAnnotations((list) => list.filter((_, index) => index !== at));
  }, [mutateAnnotations]);

  /**
   * `Shift+X` — extend the selected trendline to the right edge (§11.8).
   *
   * The extension is a projection option (`AnnotationContext.extendRight`) and not stored geometry, so
   * the anchors are untouched and what `Ctrl+S` persists is the shape the user drew. Annotations are
   * painted on the BASE canvas, so the base has to be dirtied: re-applying the current view is the
   * published way to say "the base changed" without inventing a second dirty flag.
   */
  const toggleExtendRight = useCallback((): void => {
    const ui = uiRef.current;
    ui.extendRight = !ui.extendRight;
    commit({ view: ui.view });
  }, [commit]);

  /**
   * `Ctrl+S` — the annotations, in the shape `sdk.workspace.annotations.create` takes (§11.8).
   *
   * Serialised here and handed to `onEvent` rather than written: the SDK call needs a session and an
   * `instrumentId`, and this component has neither unless a host gives them. `annotation-save` is one
   * of the three `kind`s `ChartCanvasProps.onEvent` declares, so the payload has a place to go, and
   * `serialiseAnnotation` is what guarantees the `kind` and the `anchors` match the
   * `chart_annotations` CHECK values (CHRT-05).
   */
  const saveAnnotations = useCallback((): void => {
    const emit = onEventRef.current;
    if (emit === undefined) return;
    const records = annotationsRef.current
      .filter((annotation) => annotation.editable)
      .map((annotation) =>
        serialiseAnnotation(annotation, {
          instrumentId: instrumentId ?? 0,
          sharedScope: 'private',
          sharedUserIds: [],
          style: {},
          fit: null,
        }),
      );
    emit({ kind: 'annotation-save', payload: records });
  }, [instrumentId]);

  /* ── the option keys (§11.9 `T A N L`) ───────────────────────────────────────────────────── */

  const cycleType = useCallback((): void => {
    const current = options.type ?? spec.series[0]?.type ?? 'line';
    const cycle = cyclableTypes(spec);
    const at = cycle.indexOf(current);
    // A type the data cannot support is not cycled INTO, and a spec authored with one is not cycled
    // OUT of: an OMON smile is `scatter` because the data is points, and turning it into a candle
    // series would draw a picture with no bars in it and report a type its function has no parameter
    // for. `T` is then a no-op, which is the honest answer on a chart with one possible mark.
    if (at < 0) return;
    const next = cycle[(at + 1) % cycle.length];
    if (next === undefined || next === current) return;
    setOptions((o) => ({ ...o, type: next }));
    onParamsChange?.({ type: next });
  }, [onParamsChange, options.type, spec]);

  /**
   * `P` (§11.9) — the profile view, on and off.
   *
   * A toggle rather than a cycle step, because that is what the row says ("profile view") and because
   * the way back matters: a trader who pressed `P` on a GIP chart must be able to get their candles
   * back with the same key. Refused on a spec `profile` cannot be drawn from — §11.3 ships it for
   * intraday bars only — rather than drawing a TPO profile out of daily closes.
   */
  const toggleProfile = useCallback((): void => {
    const current = options.type ?? spec.series[0]?.type ?? 'line';
    if (current === 'profile') {
      const back = spec.series[0]?.type ?? 'line';
      const next = back === 'profile' ? 'candle' : back;
      setOptions((o) => ({ ...o, type: next }));
      onParamsChange?.({ type: next });
      return;
    }
    if (!cyclableTypes(spec).includes('profile')) return;
    setOptions((o) => ({ ...o, type: 'profile' }));
    onParamsChange?.({ type: 'profile' });
  }, [onParamsChange, options.type, spec]);

  const cycleAdjust = useCallback((): void => {
    const next = !options.adjust;
    setOptions((o) => ({ ...o, adjust: next }));
    // Recorded and reported, not applied: an adjusted close is a different series, computed
    // server-side, and the client holds one (§11.9's `setParams` route — see the file header).
    onParamsChange?.({ adjust: next });
  }, [onParamsChange, options.adjust]);

  const cycleNormalise = useCallback((): void => {
    const current = options.normalise ?? spec.yAxes[0]?.normalise ?? 'none';
    const at = NORMALISE_CYCLE.indexOf(current);
    const next = NORMALISE_CYCLE[(at + 1) % NORMALISE_CYCLE.length] ?? 'none';
    setOptions((o) => ({ ...o, normalise: next }));
    onParamsChange?.({ normalise: next });
  }, [onParamsChange, options.normalise, spec.yAxes]);

  const toggleLog = useCallback((): void => {
    const current = options.log ?? spec.yAxes[0]?.scale === 'log';
    setOptions((o) => ({ ...o, log: !current }));
    onParamsChange?.({ logScale: !current });
  }, [onParamsChange, options.log, spec.yAxes]);

  /**
   * `V` (§11.9) — the VWAP overlay, on and off.
   *
   * The same list `S` edits and the same `onParamsChange({ studies })` it reports, because §11.9's
   * `V` is a shortcut for one row of the study picker and not a second kind of overlay. Refused when
   * the series carries no volume: `VWAP` declares `needs: ['volume']` and throws without it
   * (`studies/needs.ts`), and a key that killed the screen would be worse than one that did nothing.
   */
  const toggleVwap = useCallback((): void => {
    const def = STUDY_REGISTRY.VWAP;
    const series = spec.series[0];
    const have = {
      close: true,
      ohlc: series?.ohlc !== undefined,
      volume: series?.volume !== undefined,
    };
    if (!studyNeedsMet(def, have)) return;
    const on = studiesNow.some((study) => study.id === def.id);
    const next = on
      ? studiesNow.filter((study) => study.id !== def.id)
      : [
          ...studiesNow,
          {
            id: def.id,
            params: defaultParams(def),
            pane: spec.panes[0]?.id ?? 'main',
            inputSeriesId: series?.id ?? '',
          },
        ];
    setEditedStudies(next);
    onParamsChange?.({ studies: studiesPatch(next) });
  }, [onParamsChange, spec.panes, spec.series, studiesNow]);

  const addStudy = useCallback(
    (studyId: string): void => {
      const def = studyList.find((candidate) => candidate.id === studyId);
      if (def === undefined) return;
      const entry = {
        id: def.id,
        params: defaultParams(def),
        // A `main` study overlays the price pane; a `sub` study's pane is its own id (§11.6).
        pane: def.pane === 'main' ? (spec.panes[0]?.id ?? 'main') : def.id,
        inputSeriesId: spec.series[0]?.id ?? '',
      };
      const next = [...studiesNow.filter((s) => s.id !== entry.id), entry];
      setEditedStudies(next);
      onParamsChange?.({ studies: studiesPatch(next) });
      setPicker(null);
      setPickerQuery('');
    },
    [onParamsChange, spec.panes, spec.series, studiesNow],
  );

  /* ── one keystroke ───────────────────────────────────────────────────────────────────────── */

  const activate = useCallback(
    (nextPanel: boolean): void => {
      const ui = uiRef.current;
      if (ui.drawMode !== null) {
        placeAnchor();
        return;
      }
      const event = ui.eventIndex === null ? undefined : specRef.current.events?.[ui.eventIndex];
      if (event === undefined) return;
      // §11.7: `Enter` runs `event.command` in this panel, `Shift+Enter` in the next. The chart does
      // not navigate itself — `ScreenActions` is the shell's, and it is the same call the grid's
      // `onEnter` makes, so a marker and a row behave the same way.
      onEventRef.current?.({ kind: 'event', payload: event });
      if (nextPanel) actions.navigateNext(event.command);
      else actions.navigate(event.command);
    },
    [actions, placeAnchor],
  );

  const runAction = useCallback(
    (action: ChartKeyAction): void => {
      switch (action.kind) {
        case 'crosshair':
          moveCrosshair(action.slots);
          break;
        case 'pan':
          panBy(action.fraction);
          break;
        case 'zoom':
          zoomAround(action.factor);
          break;
        case 'jump':
          jumpTo(action.to);
          break;
        case 'cycle-series':
          cycleSeries(action.delta);
          break;
        case 'cycle-pane':
          cyclePane(action.delta);
          break;
        case 'cycle-type':
          cycleType();
          break;
        case 'toggle-vwap':
          toggleVwap();
          break;
        case 'toggle-profile':
          toggleProfile();
          break;
        case 'cycle-adjust':
          cycleAdjust();
          break;
        case 'cycle-normalise':
          cycleNormalise();
          break;
        case 'toggle-log':
          toggleLog();
          break;
        case 'picker':
          setPicker(action.which);
          setPickerQuery('');
          break;
        case 'toggle-events':
          toggleEventBand();
          break;
        case 'step-event':
          stepEvent(action.delta);
          break;
        case 'activate':
          activate(action.nextPanel);
          break;
        case 'toggle-draw':
          setDrawMode(uiRef.current.drawMode === null ? 'trendline' : null);
          break;
        case 'draw-kind':
          setDrawMode(action.mode);
          break;
        case 'save-annotations':
          saveAnnotations();
          break;
        case 'delete-annotation':
          deleteAnnotation();
          break;
        case 'cycle-annotation':
          cycleAnnotation(action.delta);
          break;
        case 'move-anchor':
          uiRef.current.movingAnchor = !uiRef.current.movingAnchor;
          break;
        case 'edit-label':
          setPicker('label');
          setPickerQuery('');
          break;
        case 'extend-right':
          toggleExtendRight();
          break;
        case 'toggle-pane-collapse':
          togglePaneCollapse();
          break;
        case 'cancel':
          cancelDraw();
          break;
      }
    },
    [
      activate,
      cancelDraw,
      cycleAdjust,
      cycleAnnotation,
      cycleNormalise,
      cyclePane,
      cycleSeries,
      cycleType,
      deleteAnnotation,
      jumpTo,
      moveCrosshair,
      panBy,
      saveAnnotations,
      setDrawMode,
      stepEvent,
      toggleEventBand,
      toggleExtendRight,
      toggleLog,
      togglePaneCollapse,
      toggleProfile,
      toggleVwap,
      zoomAround,
    ],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      const ui = uiRef.current;
      const action = chartKeyAction(e.nativeEvent, {
        drawing: ui.drawMode !== null,
        modal: picker !== null,
        onEvent: ui.eventIndex !== null && ui.focus.kind === 'event',
      });
      if (action === null) return;
      // Consumed here, so the panel's dispatcher does not act on it as well. Everything this file
      // declines — `Ctrl+I`, `Ctrl+P`, `Tab`, the panel keys — never reaches this line.
      e.preventDefault();
      e.stopPropagation();
      runAction(action);
    },
    [picker, runAction],
  );

  /* ── mouse: the same functions the keys call (TERM-06) ───────────────────────────────────── */

  const pointOf = useCallback(
    (e: { clientX: number; clientY: number }): { px: number; py: number } | null => {
      const host = hostRef.current;
      if (host === null) return null;
      const rect = host.getBoundingClientRect();
      return { px: e.clientX - rect.left, py: e.clientY - rect.top };
    },
    [],
  );

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      const renderer = rendererRef.current;
      const point = pointOf(e);
      if (renderer === null || point === null) return;
      hostRef.current?.focus();
      const hit: Hit | null = renderer.hitTest(point.px, point.py);
      if (hit === null) return;
      const ui = uiRef.current;
      switch (hit.kind) {
        case 'plot': {
          if (hit.seriesId !== null) {
            const at = specRef.current.series.findIndex((s) => s.id === hit.seriesId);
            if (at >= 0) ui.seriesIndex = at;
          }
          ui.focus = { kind: 'plot' };
          ui.drag = { x: point.px, slot0: ui.view.slot0, slot1: ui.view.slot1 };
          setCrosshairSlot(hit.slot);
          break;
        }
        case 'event':
          ui.eventIndex = hit.index;
          ui.focus = { kind: 'event', index: hit.index };
          setCrosshairSlot(hit.slot);
          commit({ focus: true });
          break;
        case 'legend': {
          const at = specRef.current.series.findIndex((s) => s.id === hit.seriesId);
          if (at >= 0) {
            ui.seriesIndex = at;
            ui.focus = { kind: 'legend', seriesId: hit.seriesId };
            commit({ crosshair: true, focus: true });
          }
          break;
        }
        case 'annotation':
          ui.selected = hit.index;
          ui.focus = { kind: 'annotation', index: hit.index };
          renderer.setSelectedAnnotation(hit.index);
          commit({ focus: true });
          break;
        case 'pane': {
          const at = specRef.current.panes.findIndex((p) => p.id === hit.paneId);
          if (at >= 0) ui.paneIndex = at;
          ui.focus = { kind: 'pane', paneId: hit.paneId };
          commit({ focus: true });
          break;
        }
        case 'axis':
          break;
      }
    },
    [commit, pointOf, setCrosshairSlot],
  );

  const onMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): void => {
      const renderer = rendererRef.current;
      const point = pointOf(e);
      if (renderer === null || point === null) return;
      const ui = uiRef.current;
      const drag = ui.drag;
      if (drag !== null) {
        // A drag pans through `panBy` — the function `Shift+Arrow` calls — expressed as the fraction
        // of the viewport the pointer has travelled. TERM-06 is not "the mouse also works": it is
        // "the mouse can do nothing a key cannot", and sharing the function is how that stays true.
        const plotPx = renderer.layout()[0]?.plot.w ?? 0;
        if (plotPx > 0) {
          ui.view = { slot0: drag.slot0, slot1: drag.slot1 };
          panBy((drag.x - point.px) / plotPx);
        }
        return;
      }
      const hit = renderer.hitTest(point.px, point.py);
      if (hit?.kind === 'plot') setCrosshairSlot(hit.slot);
    },
    [panBy, pointOf, setCrosshairSlot],
  );

  const endDrag = useCallback((): void => {
    uiRef.current.drag = null;
  }, []);

  /* ── mount: the renderer, the canvases, the observer, the wheel ──────────────────────────── */

  useLayoutEffect(() => {
    const host = hostRef.current;
    const base = baseRef.current;
    const overlay = overlayRef.current;
    if (host === null || base === null || overlay === null) return;

    const view = host.ownerDocument.defaultView;
    const ratioOf = (): number => dprProp ?? view?.devicePixelRatio ?? 1;
    const probe = base.getContext('2d');
    const { theme, fonts } = readChartTheme(host, probe);
    const renderer = new Renderer(base, overlay, { dpr: ratioOf(), theme, fonts });
    rendererRef.current = renderer;
    host.setAttribute('data-event-band', 'on');

    const measure = (): void => {
      const rect = host.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, ratioOf());
      schedule();
    };

    // jsdom does not lay out and its `ResizeObserver` never fires (TESTING.md §2.2), so the first
    // size is READ here rather than waited for. In a browser the observer owns every later one. A
    // resize to zero is harmless: `computeLayout` returns empty rects and nothing is drawn until the
    // element has a size.
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    measure();

    // A non-passive NATIVE listener, because React attaches `onWheel` passively at the root and
    // `preventDefault` there is ignored with a console warning: a chart that zoomed AND scrolled the
    // panel behind it on one gesture would be unusable.
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const point = pointOf(e);
      const hit = point === null ? null : renderer.hitTest(point.px, point.py);
      const anchor = hit?.kind === 'plot' ? hit.slot : undefined;
      zoomAround(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, anchor);
    };
    host.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      observer.disconnect();
      host.removeEventListener('wheel', onWheel);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      rendererRef.current = null;
    };
  }, [dprProp, pointOf, schedule, zoomAround]);

  /**
   * The spec, the studies and the annotation painter — one effect, one `setSpec`.
   *
   * `setSpec` rebuilds the slot index, the scales and every study output, and resets the viewport (a
   * new spec is a new chart), so the viewport this component holds is re-applied straight after. This
   * is also the ONLY place the spec reaches the renderer: a second caller would silently rewind a
   * streamed chart to its payload, which is the WP-13 defect this component is written against.
   */
  useEffect(() => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (renderer === null || host === null) return;
    const index = TradingDayIndex.fromSpec(drawnSpec);
    indexRef.current = index;
    closesRef.current = closesBySlotOf(drawnSpec, index);
    xLabelRef.current = xLabeller(
      drawnSpec,
      index.valueAt(0),
      index.valueAt(Math.max(0, index.length - 1)),
    );
    const { theme, fonts } = readChartTheme(host, baseRef.current?.getContext('2d') ?? null);
    renderer.setTheme(theme, fonts);
    renderer.setPlugins({
      studies: STUDY_REGISTRY,
      annotations: annotationPainter(
        { nearestSlot: (t) => index.nearestSlot(t), tsAt: (slot) => index.valueAt(slot) },
        () => closesRef.current,
        () => uiRef.current.extendRight,
        theme,
        fonts,
      ),
    });
    renderer.setSpec(drawnSpec);
    const ui = uiRef.current;
    const last = Math.max(0, index.length - 1);
    const slot0 = Math.min(ui.view.slot0, last);
    ui.view = { slot0, slot1: Math.min(Math.max(ui.view.slot1, slot0), last) };
    renderer.setState({ view: ui.view, collapsedPanes: ui.collapsed });
    renderer.setSelectedAnnotation(ui.selected);
    paintFurniture();
    schedule();
  }, [drawnSpec, paintFurniture, schedule]);

  /**
   * The live bindings (§11.5, CHRT-02, TERM-12).
   *
   * `ChartStream` decodes the frame — it owns the `b1m:` contract and the `st` that comes with it —
   * and the renderer applies the patch, because the renderer owns the arrays it draws from and the
   * dirty region that follows. There is now one owner of the growable columns: `streaming.ts` used to
   * keep a second set with a second copy of §11.5's three rules, which nothing in the product ever
   * called, and two implementations of one contract drift.
   *
   * Nothing in this effect touches React state: a stream of updates produces ZERO commits, which is
   * the rule the whole component is built around and which its test asserts. The staleness map is a
   * ref for exactly that reason — a `data-st` that arrived through a re-render would be the WP-13
   * defect (a React commit mid-stream re-issues `setSpec` and the streamed bars are gone).
   */
  useEffect(() => {
    if (live === null) return;
    const stream = new ChartStream(drawnSpec);
    if (stream.bindings.length === 0) return;
    const seriesOfSubject = new Map<string, string[]>();
    for (const binding of stream.bindings) {
      const list = seriesOfSubject.get(binding.subject) ?? [];
      list.push(binding.seriesId);
      seriesOfSubject.set(binding.subject, list);
    }
    const groups = new Map<string, { subjects: Set<string>; fields: readonly FieldId[] }>();
    for (const binding of stream.bindings) {
      const fields: readonly FieldId[] =
        binding.mode === 'append-forming-bar' ? FORMING_BAR_FIELDS : [binding.field];
      const key = fields.join(',');
      const group = groups.get(key) ?? { subjects: new Set<string>(), fields };
      group.subjects.add(binding.subject);
      groups.set(key, group);
    }
    const apply = (e: UpdateEvent): void => {
      const renderer = rendererRef.current;
      if (renderer === null) return;
      let appended = false;
      for (const { patch, st } of stream.updatesFrom(e)) {
        stateRef.current.set(patch.seriesId, st);
        if (patch.mode === 'append-forming-bar') {
          const index = indexRef.current;
          const lastTs = index.length === 0 ? Number.NaN : index.valueAt(index.length - 1);
          if (!Number.isFinite(lastTs) || patch.bar.t > lastTs) {
            // Appended here on the same condition the renderer appends there, so an anchor placed
            // after a streamed bar lands on the bar the user is looking at.
            index.append(patch.bar.t);
            appended = true;
          }
        }
        renderer.applyStream(patch);
      }
      if (appended) uiRef.current.view = renderer.state().view;
      paintFurniture();
      schedule(1);
    };
    const stops = [...groups.values()].map((group) =>
      live.subscribe([...group.subjects], group.fields, apply),
    );
    // §12.1 rule (1): a value whose subject is resyncing, or whose socket has closed, renders `stale`
    // within one second — a dead WebSocket may not leave a "live" number on the screen (TERM-12). The
    // ticker is the SOURCE's, exactly as `rt/wsBridge.ts` owns it for `grid/cellRegistry.ts`: the
    // verdict is `core/quote/staleness.ts#valueState` over a `QuoteCache` this component cannot see,
    // and a second implementation here — with a guessed `expectedIntervalMs` — would be a second
    // answer to TERM-12. So the chart declares the port and repaints when it is told. Until whoever
    // constructs the `WidgetRegistry` wires the bridge to it, a chart ages no value on its own, which
    // is the same open item `widgets/Chart.tsx` and this file's header already record.
    const staleness = live.onStaleness?.((states) => {
      let changed = false;
      for (const [subject, st] of states) {
        for (const seriesId of seriesOfSubject.get(subject) ?? []) {
          if (stateRef.current.get(seriesId) === st) continue;
          stateRef.current.set(seriesId, st);
          changed = true;
        }
      }
      // No value is re-read and no frame is scheduled: a number going stale is not a number changing
      // (`cellRegistry.restyle` makes the same distinction for the same reason).
      if (changed) paintFurniture();
    });
    return () => {
      for (const stop of stops) stop();
      staleness?.();
    };
  }, [live, drawnSpec, paintFurniture, schedule]);

  /* ── the DOM ─────────────────────────────────────────────────────────────────────────────── */

  const readoutId = `${id}-readout`;
  /**
   * The picker's rows: the typeahead, over the studies this series can actually feed (§11.6).
   *
   * Filtered by `needs` and not merely sorted by it. The picker offered all twenty-two whatever the
   * series carried, and `Enter` on one of the twelve that need a bar or a volume column threw out of
   * `Renderer.setSpec` — one keystroke from a working chart to a dead screen on any yield, rate or
   * index series. It is the same predicate the renderer skips with, so the list and the chart agree.
   */
  const pickerRows = useMemo(() => {
    if (picker !== 'study') return [];
    const series = spec.series[0];
    const have = {
      close: true,
      ohlc: series?.ohlc !== undefined,
      volume: series?.volume !== undefined,
    };
    const needle = pickerQuery.toLowerCase();
    return studyList.filter(
      (def) =>
        studyNeedsMet(def, have) &&
        (needle === '' ||
          def.id.toLowerCase().includes(needle) ||
          def.name.toLowerCase().includes(needle)),
    );
  }, [picker, pickerQuery, spec.series]);

  const currentType = options.type ?? spec.series[0]?.type ?? 'line';
  const currentNormalise = options.normalise ?? spec.yAxes[0]?.normalise ?? 'none';
  const currentLog = options.log ?? spec.yAxes[0]?.scale === 'log';

  const onPickerKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelDraw();
      hostRef.current?.focus();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (picker === 'study') {
      const first = pickerRows[0];
      if (first !== undefined) addStudy(first.id);
    } else if (picker === 'overlay') {
      if (pickerQuery !== '') onOverlayRequest?.(pickerQuery);
      setPicker(null);
    } else {
      const at = uiRef.current.selected;
      const label = pickerQuery;
      if (at !== null) {
        mutateAnnotations((list) =>
          list.map((annotation, index) => (index === at ? { ...annotation, label } : annotation)),
        );
      }
      setPicker(null);
    }
    setPickerQuery('');
    hostRef.current?.focus();
  };

  return (
    <div
      className="chart"
      ref={hostRef}
      style={HOST_STYLE}
      data-node-id={id}
      data-type={currentType}
      data-adjust={options.adjust ? 'on' : 'off'}
      data-normalise={currentNormalise}
      data-log={currentLog ? 'on' : 'off'}
      data-draw-mode={drawing ?? 'off'}
      role="application"
      aria-label={`${spec.kind} chart, ${String(spec.series.length)} series`}
      aria-describedby={readoutId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <canvas className="chart__base" style={CANVAS_STYLE} ref={baseRef} aria-hidden="true" />
      <canvas className="chart__overlay" style={CANVAS_STYLE} ref={overlayRef} aria-hidden="true" />
      <p className="chart__readout" style={SR_ONLY_STYLE} id={readoutId} ref={readoutRef} />
      <ul className="chart__legend" style={SR_ONLY_STYLE} ref={legendRef} aria-label="Series">
        {spec.series.map((series) => (
          <li
            key={series.id}
            className="chart__legend-entry"
            data-series-id={series.id}
            data-prov-idx={series.provIdx}
          >
            <span className="chart__legend-label">{series.label}</span>{' '}
            <span className="chart__legend-value" data-value-of={series.id} />
          </li>
        ))}
      </ul>
      {studiesNow.length === 0 ? null : (
        <ul className="chart__studies" style={SR_ONLY_STYLE} ref={studiesRef} aria-label="Studies">
          {studiesNow.map((study) => (
            <li key={`${study.id}:${study.pane}`} data-study-id={study.id}>
              <span className="chart__study-label">{study.id}</span>{' '}
              {/* Written imperatively from the crosshair path, like the legend values: a study's
                  number at the crosshair slot is the only place a screen reader can read it, since
                  both canvases are `aria-hidden` (§11.9). */}
              <span className="chart__study-value" data-value-of-study={study.id} />
            </li>
          ))}
        </ul>
      )}
      {drawing === null ? null : (
        <p className="chart__footer" style={FOOTER_STYLE} data-draw-footer="">
          {DRAW_MODES.map((mode) => `${DRAW_KIND_KEY[mode]} ${DRAW_MODE_LABEL[mode]}`).join(' · ')}
        </p>
      )}
      {picker === null ? null : (
        <div
          className="chart__picker"
          style={PICKER_STYLE}
          role="dialog"
          aria-label={pickerLabel(picker)}
        >
          <input
            className="chart__picker-input"
            aria-label={pickerLabel(picker)}
            // The picker is opened by a key and must be typeable without a mouse, so focus follows it
            // the moment it appears; `Escape` puts focus back on the host (§5.4, §11.9).
            autoFocus
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            onKeyDown={onPickerKeyDown}
          />
          {picker !== 'study' ? null : (
            <ul className="chart__picker-rows">
              {pickerRows.map((def) => (
                <li key={def.id}>
                  <button
                    type="button"
                    tabIndex={-1}
                    data-study-option={def.id}
                    onClick={() => addStudy(def.id)}
                  >
                    {`${def.id} — ${def.name}`}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The picker's accessible name — the three prompts §11.9 names. */
function pickerLabel(which: 'study' | 'overlay' | 'label'): string {
  if (which === 'study') return 'Study picker';
  if (which === 'overlay') return 'Overlay: security or formula';
  return 'Annotation label';
}
