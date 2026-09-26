// packages/web/src/chart/studies/types.ts — what a study is (CLIENT.md §11.6, CHRT-04).
//
// Twenty-two studies, each in its own file, each exporting one `StudyDef`; `studies/index.ts`
// collects them into the registry the study picker (`S`) types over. This file is the contract all
// twenty-two compile against, and it is only types plus the id list — a study's maths is in the
// study's own file, and the numbers it needs that are not display-only are in
// `packages/core/src/analytics/stats` and are imported from there.
//
// That last point is API-05 and it is not a style preference. `HVOL` is annualised volatility of log
// returns; `core/analytics/stats` already computes exactly that for the stats engine the API serves
// (`logReturns`, `volatility`), and a second implementation here would mean the number under the
// chart and the number in the payload could disagree about the same security on the same window.
// The same holds for `BB`'s standard deviation (`stdevOf`) and `regression_channel`'s fit
// (`olsRegression`). Those core functions take `readonly number[]` while a `StudyInput` column is a
// `Float64Array`, so a study copies the window it needs on the way in — a copy of `n` points per
// call is the price of one source of truth, and it is worth paying.
//
// The declarations are §11.6's, field for field. The one departure is spelling: §11.6 writes
// `Array<T>` and the house lint rule is `T[]`, which is the same type.

import type { SeriesColour } from '../types.js';

/**
 * The columns a study computes over: one series' data, already aligned to slots.
 *
 * `x` is the `TradingDayIndex` timestamp per slot, not a slot number — `VWAP` anchors on the session
 * and has to be able to see where a session begins (§11.6, `anchor=0`).
 *
 * `close` is always present; the other four are present only when the input series carried them.
 * With `exactOptionalPropertyTypes` an absent column is genuinely absent rather than `undefined`, so
 * whoever builds a `StudyInput` spreads conditionally, and `needs` below is what a caller checks
 * before it builds one at all. A study declaring `needs: ['volume']` and then reading `volume!`
 * would be a crash on any equity series whose payload had no volume — which is why the check is a
 * declaration rather than a convention.
 */
export interface StudyInput {
  x: Float64Array;
  close: Float64Array;
  open?: Float64Array;
  high?: Float64Array;
  low?: Float64Array;
  volume?: Float64Array;
}

/**
 * One line of study output, drawn on its pane's y-axis.
 *
 * `y` is a `Float64Array` the same length as the input, with `NaN` for the slots before the study
 * has enough points to have an answer. `NaN` and not zero, and not a shorter array offset by the
 * window: a zero would draw a line at zero for the first 19 bars of a 20-period average, and an
 * offset array would make every consumer — the crosshair readout, the legend, the incremental
 * `update`, the downsampler — carry the offset. A gap is what the renderer already knows how to not
 * draw (§11.2).
 *
 * `fillTo` names another line's `id` to shade between (Bollinger's band, Ichimoku's cloud).
 */
export interface StudyLine {
  id: string;
  label: string;
  y: Float64Array;
  style: { color: SeriesColour; width?: number; dashed?: boolean; fillTo?: string };
}

/**
 * What one study produces for one input (§11.6).
 *
 * `bands` is separate from `StudyLine.fillTo` because a band has its own alpha and names both edges,
 * which is what lets Bollinger shade upper-to-lower without either line owning the fill. `levels`
 * are the horizontal reference lines a sub-pane study is read against — RSI's 30/70, CCI's ±100,
 * ROC's 0 — and they belong to the study rather than to the spec's `reference[]`, because they are
 * properties of the indicator and not of the instrument.
 */
export interface StudyOutput {
  lines: StudyLine[];
  bands?: { upper: string; lower: string; alpha: number }[];
  histogram?: { id: string; y: Float64Array };
  levels?: number[];
}

/**
 * A study, whole: its identity, where it draws, what it can be asked for, and how it computes.
 *
 * `params` carries the picker's form as data — label, default, min, max, step — so the study picker
 * is written once against this rather than once per study, and so `ScreenCtx.setParams({ studies })`
 * can persist a parameter set the study itself validated the bounds of (§11.6).
 *
 * `update` is optional and that is deliberate. On a streaming tick only the last slot changed, and a
 * study with a recurrence — an EMA, an OBV — can answer for it in constant time; one without
 * (`ICHIMOKU`, `PSAR`) has no honest incremental form, so it declares none and the caller recomputes
 * the last `window` points instead (§11.5). Making it required would have produced seven `update`s
 * that quietly recompute everything and a streaming path whose cost nobody could see.
 */
export interface StudyDef {
  id: string;
  name: string;
  /** `main` overlays the price axis; `sub` gets its own linked pane, shared x-axis (§11.6). */
  pane: 'main' | 'sub';
  params: {
    name: string;
    label: string;
    default: number;
    min: number;
    max: number;
    step: number;
  }[];
  /** Which `StudyInput` columns must be present before this study may be asked to compute. */
  needs: ('close' | 'ohlc' | 'volume')[];
  compute(input: StudyInput, params: Record<string, number>): StudyOutput;
  /** Incremental last-slot update (§11.5); absent when the study has no honest recurrence. */
  update?(
    prev: StudyOutput,
    input: StudyInput,
    params: Record<string, number>,
    lastIndex: number,
  ): StudyOutput;
  /** How the pane's axis labels its values; absent means the price axis' own format. */
  yFmt?: 'px' | 'pct' | 'int' | 'ratio';
}

/**
 * The twenty-two ids of the initial registry, in the order §11.6 tabulates them (main studies then
 * sub studies). CHRT-04 asks for about a hundred; twenty-two is the stated gap (§11.11, §18 Q4).
 *
 * The list is here, beside the type, so that `studies/index.ts` can be typed
 * `Record<StudyId, StudyDef>` and a study file that is written but never registered — or a registry
 * entry with a typo in its key — is a compile error rather than a name the picker cannot find.
 */
export const STUDY_IDS = [
  'SMA',
  'EMA',
  'WMA',
  'BB',
  'DONCHIAN',
  'KELTNER',
  'PSAR',
  'ICHIMOKU',
  'VWAP',
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
] as const;

/** One of the twenty-two. The picker's typeahead and a persisted params list both speak this. */
export type StudyId = (typeof STUDY_IDS)[number];
