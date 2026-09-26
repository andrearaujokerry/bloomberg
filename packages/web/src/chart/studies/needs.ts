// packages/web/src/chart/studies/needs.ts — `StudyDef.needs`, checked (CLIENT.md §11.6, CHRT-04).
//
// Its own module, imported by both of the callers that must agree, and the reason is the module
// graph. `Renderer` needs this predicate and must not import `studies/index.ts`: that file pulls in
// all twenty-two studies, and the whole point of `RendererPlugins` is that the registry is INJECTED —
// a renderer that imported it would bundle the study maths into every host that draws a chart, and
// the seam `setPlugins` exists to keep would be decorative. `studies/index.ts` re-exports this for
// the study picker, so both sides ask one function.
//
// Why the check exists at all: `studies/types.ts` says `needs` "is what a caller checks before it
// builds a `StudyInput` at all", and the twelve studies needing `ohlc` or `volume` THROW when the
// column is absent — correctly, because a line of `NaN` reads as broken maths. Nothing checked.
// `Renderer.computeStudies` called `compute` unconditionally, so a persisted `layout.chart.studies`
// holding `ATR` threw a `RangeError` out of `setSpec` on any close-only series (`GP.govt.json` is
// one: its `primary.o/h/l/v` are all null) and the screen was dead rather than showing an empty pane.
// The `S` picker offered all twenty-two whatever the series carried, which is the same defect from
// the other end.

import type { StudyDef } from './types.js';

/**
 * Which columns a series can offer a study — the input side of `StudyDef.needs`.
 *
 * `close` is a column every series has; the other two are the ones a payload may not carry, and both
 * absences are real in this build — a yield or rate series has no bar, and no index series reports
 * volume.
 */
export interface StudyColumns {
  readonly close: boolean;
  readonly ohlc: boolean;
  readonly volume: boolean;
}

/** Whether a study may be asked to compute over a series carrying these columns (§11.6). */
export function studyNeedsMet(def: StudyDef, have: StudyColumns): boolean {
  return def.needs.every((need) => have[need]);
}
