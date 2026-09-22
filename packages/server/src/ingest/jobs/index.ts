// GENERATED — do not edit.
//
// Written by `scripts/gen-function-index.ts` (`npm run gen:functions`), WORKPLAN §1.10.
// Glob: packages/server/src/ingest/jobs/*.ts (minus index.ts)
// One module per row of the ingest job table (PROVIDERS §13). `IngestJob.id` is the module basename.
//
// Add a module by adding the file and re-running the generator. Hand edits are
// overwritten and fail CI, which re-runs the generator and diffs the result.

import * as cboeEuIndices from './cboeEuIndices.js';
import * as cboeOptions from './cboeOptions.js';
import * as cboeQuotes from './cboeQuotes.js';
import * as crypto from './crypto.js';
import * as dqMonitors from './dqMonitors.js';
import * as fxEod from './fxEod.js';
import * as fxIntraday from './fxIntraday.js';
import * as partitionMaintenance from './partitionMaintenance.js';
import * as reconcile from './reconcile.js';
import * as retentionPurge from './retentionPurge.js';
import * as secNport from './secNport.js';
import * as shortInterest from './shortInterest.js';
import * as ssgaHoldings from './ssgaHoldings.js';
import * as symbologyRefresh from './symbologyRefresh.js';
import * as universeSymbolBook from './universeSymbolBook.js';
import * as usageDeclarations from './usageDeclarations.js';
import * as yahooDaily from './yahooDaily.js';
import * as yahooIntraday from './yahooIntraday.js';

export {
  cboeEuIndices,
  cboeOptions,
  cboeQuotes,
  crypto,
  dqMonitors,
  fxEod,
  fxIntraday,
  partitionMaintenance,
  reconcile,
  retentionPurge,
  secNport,
  shortInterest,
  ssgaHoldings,
  symbologyRefresh,
  universeSymbolBook,
  usageDeclarations,
  yahooDaily,
  yahooIntraday,
};

/** Every module the glob matched, keyed by its file (or directory) name. */
export const ingestJobModules = {
  cboeEuIndices,
  cboeOptions,
  cboeQuotes,
  crypto,
  dqMonitors,
  fxEod,
  fxIntraday,
  partitionMaintenance,
  reconcile,
  retentionPurge,
  secNport,
  shortInterest,
  ssgaHoldings,
  symbologyRefresh,
  universeSymbolBook,
  usageDeclarations,
  yahooDaily,
  yahooIntraday,
} as const;
