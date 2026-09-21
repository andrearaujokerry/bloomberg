// GENERATED — do not edit.
//
// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.
// Glob: packages/server/src/ingest/jobs/*.ts (minus index.ts)
// One module per row of the ingest job table (PROVIDERS §13). `IngestJob.id` is the module basename.
//
// Add a module by adding the file and re-running the generator. Hand edits are
// overwritten and fail CI, which re-runs the generator and diffs the result.

import * as secNport from './secNport.js';
import * as shortInterest from './shortInterest.js';
import * as ssgaHoldings from './ssgaHoldings.js';
import * as symbologyRefresh from './symbologyRefresh.js';
import * as universeSymbolBook from './universeSymbolBook.js';

export {
  secNport,
  shortInterest,
  ssgaHoldings,
  symbologyRefresh,
  universeSymbolBook,
};

/** Every module the glob matched, keyed by its file (or directory) name. */
export const ingestJobModules = {
  secNport,
  shortInterest,
  ssgaHoldings,
  symbologyRefresh,
  universeSymbolBook,
} as const;
