// GENERATED — do not edit.
//
// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.
// Glob: packages/server/src/http/routes/*.ts (minus index.ts)
// One module per route group, so `http/app.ts` stays frozen after WP-01 (WORKPLAN §18.3).
//
// Add a module by adding the file and re-running the generator. Hand edits are
// overwritten and fail CI, which re-runs the generator and diffs the result.

import * as health from './health.js';

export {
  health,
};

/** Every module the glob matched, keyed by its file (or directory) name. */
export const routeModules = {
  health,
} as const;
