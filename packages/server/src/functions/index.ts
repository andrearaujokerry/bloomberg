// GENERATED — do not edit.
//
// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.
// Glob: packages/server/src/functions/*/resolve.ts (directories only — one per function code)
// Server-side resolvers. Hand-written siblings (runner.ts, context.ts, resultCache.ts, export.ts) are NOT function modules and are excluded by the glob.
//
// Add a module by adding the file and re-running the generator. Hand edits are
// overwritten and fail CI, which re-runs the generator and diffs the result.

import * as DES from './DES/resolve.js';
import * as GIP from './GIP/resolve.js';
import * as GP from './GP/resolve.js';
import * as HELP from './HELP/resolve.js';
import * as HP from './HP/resolve.js';
import * as MSG from './MSG/resolve.js';
import * as N from './N/resolve.js';
import * as NI from './NI/resolve.js';
import * as Q from './Q/resolve.js';
import * as QM from './QM/resolve.js';
import * as SECF from './SECF/resolve.js';
import * as TOP from './TOP/resolve.js';
import * as W from './W/resolve.js';
import * as WEI from './WEI/resolve.js';

export {
  DES,
  GIP,
  GP,
  HELP,
  HP,
  MSG,
  N,
  NI,
  Q,
  QM,
  SECF,
  TOP,
  W,
  WEI,
};

/** Every module the glob matched, keyed by its file (or directory) name. */
export const functionModules = {
  DES,
  GIP,
  GP,
  HELP,
  HP,
  MSG,
  N,
  NI,
  Q,
  QM,
  SECF,
  TOP,
  W,
  WEI,
} as const;
