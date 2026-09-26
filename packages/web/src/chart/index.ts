// packages/web/src/chart/index.ts — the chart engine's public surface (CLIENT.md §11).
//
// One import is enough to build a `WidgetRegistry`:
//
// ```ts
// import { ChartCanvas } from '../chart/index.js';
// const widgets: WidgetRegistry = { ChartCanvas, LiveGrid };
// ```
//
// What is exported is what a HOST needs: the component, the renderer and its state types (a host that
// drives a chart without React — a thumbnail, a print path — constructs a `Renderer` directly), the
// study registry and its types (the study picker and a screen manifest both address studies by id),
// the live seam, and the value tables a caller has to agree with rather than restate (the twelve
// series types, the seven draw modes and their labels).
//
// `studyNeedsMet` and `cyclableTypes` are exported for the same reason as the value tables: both are
// questions a host asks before it offers something. A toolbar listing the studies a series can feed, or
// the series types a function's `type` parameter will accept, must ask the same predicate the chart
// does — a picker that offers `ATR` on a yield series is one keystroke from a dead screen, and a type
// cycle that leaves a function's own enum breaks the params round trip.
//
// What is NOT exported is the internals: `scales.ts`, `layers.ts`, `series.ts`, `downsample.ts`,
// `tradingDayIndex.ts`, `events.ts` and the two study fragments. Every one of them is reached through
// `Renderer` or through `studies`, they are tested directly by path (`test/chart/**`), and a host that
// imported `series.ts#SERIES_DRAWS` would be drawing on a canvas the renderer believes it owns.
// `annotations.ts` is the one exception in part: `serialiseAnnotation` and `annotationFromRecord` are
// the two halves of the `chart_annotations` round trip (CHRT-05), and the screen that calls
// `sdk.workspace.annotations.list` needs them to merge what it loaded into the spec.

export { ChartCanvas, ChartLiveContext, chartKeyAction, useChartLive } from './ChartCanvas.js';
export type {
  ChartCanvasExtraProps,
  ChartKeyAction,
  ChartKeyEnv,
  ChartLiveSource,
  ChartParamsPatch,
  FullChartCanvasProps,
} from './ChartCanvas.js';
export { cyclableTypes, DRAW_KIND_KEY, PAN_FRACTION, ZOOM_STEP } from './ChartCanvas.js';

export { Renderer } from './renderer.js';
export type { AnnotationPainter, RendererPlugins } from './renderer.js';

export { defaultParams, studies, studyList, studyNeedsMet, STUDY_IDS } from './studies/index.js';
export type { StudyColumns } from './studies/needs.js';
export type { StudyDef, StudyId, StudyInput, StudyLine, StudyOutput } from './studies/types.js';

export { annotationFromRecord, serialiseAnnotation } from './annotations.js';
export type { ChartAnnotation } from './annotations.js';

export {
  DRAW_MODES,
  DRAW_MODE_ANCHORS,
  DRAW_MODE_LABEL,
  SERIES_TYPES,
} from './types.js';
export type {
  ChartFocus,
  ChartFonts,
  ChartSeries,
  ChartSpec,
  ChartState,
  ChartTheme,
  DrawMode,
  Hit,
  PaneLayout,
  Rect,
  SeriesType,
  StreamPatch,
  Viewport,
  YAxisLayout,
} from './types.js';

/** The props `screen/widgets/Chart.tsx` passes — re-exported so a host needs one import. */
export type { ChartCanvasProps } from '../screen/widgets/registry.js';
