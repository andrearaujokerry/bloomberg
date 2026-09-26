// packages/web/src/chart/studies/index.ts — the twenty-two-study registry (CLIENT.md §11.6,
// CHRT-04).
//
// The maths is in `trend.ts` (the nine `main` overlays) and `oscillators.ts` (the thirteen `sub`
// pane studies), and where core already owns a formula the study calls core rather than repeating it
// (API-05: `stdevOf` for Bollinger, `olsRegression` for the regression channel, `logReturns` +
// `volatility` for HVOL). This file is the join and nothing else: one `Record<StudyId, StudyDef>`
// for the study picker (`S`), for a screen manifest's study list and for `Renderer.setPlugins`.
//
// ## Why the join is checked at load and not only by the compiler
//
// `trend.ts` types its fragment `satisfies Record<TrendStudyId, StudyDef>`, so its nine ids are a
// compile-time fact. `oscillators.ts` types its own fragment `Readonly<Record<string, StudyDef>>` —
// a wider type — so the thirteen `sub` ids are NOT checked by the compiler: a typo there would
// produce a registry of twenty-two entries with one key the picker cannot resolve and one study
// nobody can reach, and `Object.freeze` would make it permanent. {@link studies} is therefore built
// by walking `STUDY_IDS` (the normative list, beside the type) and demanding an entry for every one,
// so a missing or misspelled id is an error at module load naming the id, on the first import, in
// every test and in the browser — rather than a study silently absent from the picker.
//
// The reverse direction is checked too. An entry present in a fragment but absent from `STUDY_IDS`
// is a study that has been written, tested and then dropped on the floor: nothing would offer it.
// That is the same defect seen from the other side, so it is refused the same way.

import { oscillatorStudies } from './oscillators.js';
import { trendStudies } from './trend.js';
import { STUDY_IDS } from './types.js';
import type { StudyDef, StudyId } from './types.js';

/**
 * The two fragments, merged. Declared `Record<string, StudyDef>` on purpose: this is the *unchecked*
 * shape, and the checks below are what turn it into a `Record<StudyId, StudyDef>`.
 */
const FRAGMENTS: Readonly<Record<string, StudyDef>> = {
  ...trendStudies,
  ...oscillatorStudies,
};

/** Every id the fragments registered, so an unlisted study can be named in the error. */
const UNLISTED = Object.keys(FRAGMENTS).filter(
  (id) => !(STUDY_IDS as readonly string[]).includes(id),
);

if (UNLISTED.length > 0) {
  throw new Error(
    `chart/studies: ${UNLISTED.join(', ')} is registered but not in STUDY_IDS — the study picker ` +
      'reads STUDY_IDS, so nothing would offer it (CLIENT.md §11.6)',
  );
}

/**
 * One study, or an error naming the gap.
 *
 * The key and `def.id` are compared here as well as in the test, because they are two different
 * claims: the key is how the picker and a persisted `layout.chart.studies` address the study, and
 * `def.id` is what `StudyOutput`'s pane and legend are labelled from. A copy-paste that leaves
 * `ATR`'s id on a new study gives a registry that resolves `KELTNER` to a def calling itself `ATR`,
 * and the sub pane then appears under the wrong title with the wrong parameters in the picker.
 */
function entry(id: StudyId): StudyDef {
  const def = FRAGMENTS[id];
  if (def === undefined) {
    throw new Error(
      `chart/studies: ${id} is in STUDY_IDS but no fragment registers it — the study picker would ` +
        'offer a study that cannot be resolved (CLIENT.md §11.6)',
    );
  }
  if (def.id !== id) {
    throw new Error(
      `chart/studies: registered under ${id} but StudyDef.id is ${def.id} — the picker addresses ` +
        'a study by its key and labels it by its id, so the two must agree (CLIENT.md §11.6)',
    );
  }
  return def;
}

/**
 * The initial registry: twenty-two studies (CLIENT.md §11.6; CHRT-04's "~100" is the stated gap,
 * §11.11 and §18 Q4).
 *
 * Frozen, as both fragments are. The picker reads it, `Renderer.setPlugins` holds a reference to it
 * for the life of a chart, and a persisted layout names its keys; none of those has any business
 * adding an entry at runtime, and a study added after a chart mounted would not be recomputed for
 * the specs already resolved.
 */
export const studies: Readonly<Record<StudyId, StudyDef>> = Object.freeze(
  Object.fromEntries(STUDY_IDS.map((id) => [id, entry(id)])) as Record<StudyId, StudyDef>,
);

/** The registry as a list, in `STUDY_IDS` order — the study picker's rows (`S`, §11.6). */
export const studyList: readonly StudyDef[] = Object.freeze(STUDY_IDS.map((id) => studies[id]));

/**
 * The default parameters of one study, from its own `params` table.
 *
 * The picker adds a study "with defaults" on `Enter` (§11.9) and a `ChartSpec.studies[]` entry
 * carries `params` as a plain record, so the defaults have to be materialised somewhere. Here, from
 * `StudyDef.params`, rather than in the component: a second table of defaults would be a second
 * answer to "what is RSI's n", and the golden fixtures are computed against this one.
 */
export function defaultParams(def: StudyDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const param of def.params) out[param.name] = param.default;
  return out;
}

export { STUDY_IDS } from './types.js';
/**
 * `needs`, checked — re-exported so the study picker asks the same function the renderer does
 * (`studies/needs.ts` explains why it is not declared here).
 */
export { studyNeedsMet } from './needs.js';
export type { StudyColumns } from './needs.js';
export type {
  StudyDef,
  StudyId,
  StudyInput,
  StudyLine,
  StudyOutput,
} from './types.js';
