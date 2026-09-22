// GENERATED — do not edit.
//
// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.
// Glob: packages/server/src/http/routes/*.ts (minus index.ts)
// One module per route group, so `http/app.ts` stays frozen after WP-01 (WORKPLAN §18.3).
//
// Add a module by adding the file and re-running the generator. Hand edits are
// overwritten and fail CI, which re-runs the generator and diffs the result.

import * as admin from './admin.js';
import * as auth from './auth.js';
import * as data from './data.js';
import * as $export from './export.js';
import * as fields from './fields.js';
import * as functions from './functions.js';
import * as health from './health.js';
import * as reference from './reference.js';
import * as search from './search.js';
import * as status from './status.js';
import * as universe from './universe.js';
import * as usage from './usage.js';
import * as workspaces from './workspaces.js';

export {
  admin,
  auth,
  data,
  $export,
  fields,
  functions,
  health,
  reference,
  search,
  status,
  universe,
  usage,
  workspaces,
};

/** Every module the glob matched, keyed by its file (or directory) name. */
export const routeModules = {
  admin,
  auth,
  data,
  $export,
  fields,
  functions,
  health,
  reference,
  search,
  status,
  universe,
  usage,
  workspaces,
} as const;
